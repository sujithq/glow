export function exactVersion(node) {
  switch (node.ecosystem) {
    case 'npm': return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(node.version);
    case 'PyPI': return /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/.test(node.version);
    case 'NuGet': return /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(node.version);
    default: return false;
  }
}

function nugetVersionKey(version) {
  const [release, prerelease = ''] = version.split('+')[0].toLowerCase().split(/-(.*)/s);
  const parts = release.split('.').map(part => BigInt(part).toString());
  while (parts.length < 4) parts.push('0');
  return `${parts.join('.')}-${prerelease}`;
}

async function json(url, options, fetcher, signal) {
  const response = await fetcher(url, {
    ...options, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(12000)]),
    credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function enrichNode(original, { fetcher = fetch, signal } = {}) {
  const node = structuredClone(original);
  const baseline = node.configuredEvidence ?? {
    status: node.status, advisories: node.advisories, vulnerabilityCount: node.vulnerabilityCount,
    deprecated: node.deprecated, license: node.license, description: node.description,
  };
  node.configuredEvidence = structuredClone(baseline);
  Object.assign(node, structuredClone(baseline));
  for (const field of ['latest', 'updateAvailable', 'githubStatus', 'checkedAt']) delete node[field];
  node.scan = 'not checked';
  node.errors = [];
  if (node.kind === 'package') {
    if (node.ecosystem === 'npm') {
      try {
        const metadata = await json(`https://registry.npmjs.org/${encodeURIComponent(node.name)}/latest`, {}, fetcher, signal);
        node.latest = typeof metadata.version === 'string' ? metadata.version : '';
        node.license = typeof metadata.license === 'string' ? metadata.license : node.license;
        node.description = typeof metadata.description === 'string' ? metadata.description : node.description;
        node.updateAvailable = Boolean(exactVersion(node) && node.latest && node.version !== node.latest);
        if (typeof metadata.deprecated === 'string') node.deprecated = true;
      } catch (error) {
        node.errors.push(`npm metadata: ${error.message}`);
      }
    }
    if (node.ecosystem === 'NuGet') {
      try {
        const metadata = await json(`https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(node.name.toLowerCase())}/index.json`, {}, fetcher, signal);
        if (!Array.isArray(metadata?.versions) || !metadata.versions.length
          || metadata.versions.some(version => typeof version !== 'string' || !exactVersion({ ecosystem: 'NuGet', version }))) {
          throw new Error('Invalid NuGet versions response');
        }
        node.latest = metadata.versions.filter(version => !version.split('+')[0].includes('-')).at(-1) ?? '';
        node.updateAvailable = Boolean(exactVersion(node) && node.latest
          && nugetVersionKey(node.version) !== nugetVersionKey(node.latest));
      } catch (error) {
        node.errors.push(`NuGet metadata: ${error.message}`);
      }
    }
    if (!['npm', 'PyPI', 'NuGet'].includes(node.ecosystem)) {
      node.scan = 'unsupported ecosystem';
    } else if (exactVersion(node)) {
      try {
        const result = await json('https://api.osv.dev/v1/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            package: { name: node.ecosystem === 'NuGet' ? node.packageName ?? node.name : node.name, ecosystem: node.ecosystem },
            version: node.version,
          }),
        }, fetcher, signal);
        if (!result || typeof result !== 'object' || (result.vulns !== undefined && !Array.isArray(result.vulns))) {
          throw new Error('Invalid OSV response');
        }
        const findings = (result.vulns ?? []).filter(item => !item.withdrawn).map(item => ({
          id: item.id, summary: item.summary ?? 'See advisory for details',
          severity: item.database_specific?.severity ?? 'unknown',
        }));
        node.advisories = [...new Map([...node.advisories, ...findings].map(item => [item.id, item])).values()];
        node.vulnerabilityCount = Math.max(node.vulnerabilityCount, node.advisories.length);
        node.scan = node.vulnerabilityCount ? 'findings' : node.ecosystem === 'NuGet' ? 'limited coverage' : 'clean';
        node.checkedAt = new Date().toISOString();
      } catch (error) {
        node.scan = 'unavailable';
        node.errors.push(`OSV: ${error.message}`);
      }
    } else {
      node.scan = 'unresolved version';
    }
  }
  if (node.repository) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(node.repository)) {
      node.errors.push('GitHub repository must be owner/repo.');
    } else {
      try {
        const result = await json(`https://api.github.com/repos/${node.repository}/commits/HEAD/status`, {
          headers: { Accept: 'application/vnd.github+json' },
        }, fetcher, signal);
        node.githubStatus = result.total_count ? result.state : 'no commit statuses';
        if (['failure', 'error'].includes(node.githubStatus)) node.status = 'critical';
        if (node.githubStatus === 'pending') node.status = node.status === 'critical' ? 'critical' : 'warning';
      } catch (error) {
        node.errors.push(`GitHub: ${error.message}`);
      }
    }
  }
  return node;
}

export async function refreshGraph(graph, options = {}) {
  const result = { ...graph, nodes: new Array(graph.nodes.length) };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, graph.nodes.length) }, async () => {
    while (next < graph.nodes.length) {
      if (options.signal?.aborted) throw options.signal.reason;
      const index = next++;
      result.nodes[index] = await enrichNode(graph.nodes[index], options);
    }
  }));
  return { ...result, refreshedAt: new Date().toISOString() };
}
