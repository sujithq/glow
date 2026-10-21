import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, health } from '../src/parser.js';
import { enrichNode, refreshGraph, exactVersion } from '../src/data-fetcher.js';

const node = (extra = {}) => normalizeConfig({ dependencies: [{ name: 'test', version: '1.0.0', ...extra }] }).nodes[0];
const response = data => ({ ok: true, json: async () => data });
test('queries npm and OSV for exact versions and highlights vulnerabilities', async () => {
  const calls = [];
  const original = node();
  const result = await enrichNode(original, { fetcher: async (url, options) => {
    calls.push([url, options]);
    return response(url.includes('npmjs') ? { version: '2.0.0', license: 'MIT' }
      : { vulns: [{ id: 'GHSA-test', summary: 'Finding' }, { id: 'withdrawn', withdrawn: '2020-01-01' }] });
  } });
  assert.equal(result.scan, 'findings');
  assert.equal(result.vulnerabilityCount, 1);
  assert.equal(result.updateAvailable, true);
  assert.equal(health(result), 'critical');
  assert.deepEqual(JSON.parse(calls[1][1].body).package, { name: 'test', ecosystem: 'npm' });
  assert.equal(original.scan, 'not checked');
});
test('ranges, wildcards, URLs, and aliases are not sent to OSV as resolved versions', async () => {
  for (const version of ['^1.0.0', '~1.0.0', '*', 'latest', 'npm:other@1.0.0', 'https://example.com/x']) {
    const result = await enrichNode(node({ version }), { fetcher: async url => {
      assert.ok(url.startsWith('https://registry.npmjs.org/'));
      return response({ version: '2.0.0' });
    } });
    assert.equal(result.scan, 'unresolved version');
  }
  assert.equal(exactVersion(node({ ecosystem: 'PyPI', version: '1.2.3rc1' })), true);
});
test('API errors remain visible and never imply clean security results', async () => {
  const result = await enrichNode(node(), { fetcher: async () => ({ ok: false, status: 429 }) });
  assert.equal(result.scan, 'unavailable');
  assert.equal(result.errors.length, 2);
  assert.equal(health(result, 'security'), 'warning');
});
test('successful empty OSV result clears only live findings, not configured evidence', async () => {
  const result = await enrichNode(node({ vulnerabilities: 2 }), { fetcher: async () => response({}) });
  assert.equal(result.vulnerabilityCount, 2);
  assert.equal(result.scan, 'findings');
});
test('GitHub errors, missing statuses, and failures are distinct', async () => {
  const service = normalizeConfig({ services: [{ name: 'api', repository: 'owner/repo' }] }).nodes[0];
  const failed = await enrichNode(service, { fetcher: async () => response({ total_count: 1, state: 'failure' }) });
  assert.equal(failed.status, 'critical');
  const empty = await enrichNode(service, { fetcher: async () => response({ total_count: 0, state: 'pending' }) });
  assert.equal(empty.githubStatus, 'no commit statuses');
  assert.equal(empty.status, 'healthy');
  const invalid = await enrichNode({ ...service, repository: 'https://evil.test' }, { fetcher: () => assert.fail('must not fetch arbitrary URL') });
  assert.equal(invalid.errors.length, 1);
});
test('refresh uses bounded concurrency and leaves the input unchanged', async () => {
  const graph = normalizeConfig({ dependencies: Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })) });
  let active = 0, peak = 0;
  const result = await refreshGraph(graph, { fetcher: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return response({});
  } });
  assert.ok(peak <= 4);
  assert.ok(result.nodes.every(node => node.scan === 'clean'));
  assert.ok(graph.nodes.every(node => node.scan === 'not checked'));
  assert.ok(result.refreshedAt);
});
test('aborted refresh does not continue processing a queue', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(refreshGraph({ nodes: [node()], edges: [] }, { signal: controller.signal }), { name: 'AbortError' });
});
test('repeated API refresh replaces live findings but retains configured evidence', async () => {
  const configured = node({ vulnerabilities: [{ id: 'configured' }] });
  const first = await enrichNode(configured, { fetcher: async url => response(url.includes('osv')
    ? { vulns: [{ id: 'live' }] } : { version: '2.0.0', deprecated: 'obsolete' }) });
  assert.equal(first.vulnerabilityCount, 2);
  assert.equal(first.deprecated, true);
  const second = await enrichNode(first, { fetcher: async () => response({}) });
  assert.deepEqual(second.advisories.map(item => item.id), ['configured']);
  assert.equal(second.vulnerabilityCount, 1);
  assert.equal(second.deprecated, false);
  assert.equal(first.advisories.length, 2);
  const cleanFirst = await enrichNode(node(), { fetcher: async () => response({ vulns: [{ id: 'live' }] }) });
  const cleanSecond = await enrichNode(cleanFirst, { fetcher: async () => response({}) });
  assert.equal(cleanSecond.scan, 'clean');
  assert.equal(cleanSecond.vulnerabilityCount, 0);
});
test('repeated API refresh resets live GitHub failure on recovery', async () => {
  const service = normalizeConfig({ services: [{ name: 'api', repository: 'owner/repo' }] }).nodes[0];
  const failed = await enrichNode(service, { fetcher: async () => response({ total_count: 1, state: 'failure' }) });
  const recovered = await enrichNode(failed, { fetcher: async () => response({ total_count: 1, state: 'success' }) });
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.githubStatus, 'success');
});

test('exact version rules are ecosystem-specific and conservative for NuGet', () => {
  for (const version of ['1', '1.2', '1.2.3', '1.2.3.4', '1.2.3-rc.1', '1.2.3+build.7']) {
    assert.equal(exactVersion({ ecosystem: 'NuGet', version }), true, version);
  }
  for (const version of ['*', '1.*', '[1.0]', '[1,2)', '>=1.0', '$(Version)', '1.2rc1', '1.2.3.4.5', '1.0-', '1.0-a..b']) {
    assert.equal(exactVersion({ ecosystem: 'NuGet', version }), false, version);
  }
  assert.equal(exactVersion({ ecosystem: 'unknown', version: '1.2.3' }), false);
});

const nugetNode = (extra = {}) => ({ ...node(), name: 'newtonsoft.json', id: 'newtonsoft.json', ecosystem: 'NuGet', ...extra });

test('NuGet registry uses fixed lowercase endpoint, latest stable release and shared request protections', async () => {
  const calls = [];
  const controller = new AbortController();
  const original = nugetNode({ version: '12.0.1' });
  const result = await enrichNode(original, { signal: controller.signal, fetcher: async (url, options) => {
    calls.push([url, options]);
    return response(new URL(url).hostname === 'api.nuget.org'
      ? { versions: ['12.0.1', '13.0.3', '14.0.1-beta1'] }
      : { vulns: [{ id: 'GHSA-nuget-test', summary: 'NuGet finding' }] });
  } });
  assert.equal(calls[0][0], 'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    package: { name: 'newtonsoft.json', ecosystem: 'NuGet' }, version: '12.0.1',
  });
  for (const [, options] of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(result.latest, '13.0.3');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.scan, 'findings');
  assert.equal(result.license, original.license);
  assert.equal(original.scan, 'not checked');
});

test('NuGet normalized equivalent versions do not report metadata-only differences', async () => {
  for (const version of ['01.0', '1.0.0.0', '1.0.0+build']) {
    const result = await enrichNode(nugetNode({ version }), { fetcher: async url =>
      response(new URL(url).hostname === 'api.nuget.org' ? { versions: ['1.0.0'] } : {}) });
    assert.equal(result.updateAvailable, false, version);
    assert.equal(result.scan, 'limited coverage');
  }
});

test('NuGet unresolved declarations get metadata but never a clean security scan', async () => {
  for (const version of ['>=1.0.0', '$(PackageVersion)', '[1.0,2.0)', '1.*', '*']) {
    const result = await enrichNode(nugetNode({ version }), { fetcher: async url => {
      assert.equal(new URL(url).hostname, 'api.nuget.org');
      return response({ versions: ['1.0.0'] });
    } });
    assert.equal(result.scan, 'unresolved version');
    assert.equal(result.updateAvailable, false);
    assert.equal(health(result, 'security'), 'warning');
  }
});

test('NuGet registry failures and malformed responses remain independent from OSV results', async () => {
  for (const metadata of [null, {}, { versions: [] }, { versions: [42] }, { versions: ['latest'] }]) {
    const result = await enrichNode(nugetNode(), { fetcher: async url =>
      response(new URL(url).hostname === 'api.nuget.org' ? metadata : {}) });
    assert.match(result.errors[0], /NuGet metadata: Invalid NuGet/);
    assert.equal(result.scan, 'limited coverage');
  }
  const failed = await enrichNode(nugetNode(), { fetcher: async () => ({ ok: false, status: 429 }) });
  assert.equal(failed.errors.length, 2);
  assert.equal(failed.scan, 'unavailable');
  assert.equal(health(failed, 'security'), 'warning');
});

test('unknown ecosystems never query OSV or receive scan clearance', async () => {
  const result = await enrichNode({ ...node(), ecosystem: 'unsupported' }, {
    fetcher: () => assert.fail('unsupported providers must not be queried'),
  });
  assert.equal(result.scan, 'unsupported ecosystem');
  assert.equal(health(result, 'security'), 'warning');
});

test('NuGet prerelease-only metadata does not invent a stable latest release', async () => {
  const result = await enrichNode(nugetNode(), { fetcher: async url =>
    response(new URL(url).hostname === 'api.nuget.org' ? { versions: ['1.0.0-beta'] } : {}) });
  assert.equal(result.latest, '');
  assert.equal(result.updateAvailable, false);
});

test('NuGet refresh preserves configured findings and replaces live findings', async () => {
  const configured = nugetNode({ advisories: [{ id: 'configured' }], vulnerabilityCount: 1 });
  const first = await enrichNode(configured, { fetcher: async url => response(new URL(url).hostname === 'api.nuget.org'
    ? { versions: ['1.0.0'] } : { vulns: [{ id: 'live' }] }) });
  const second = await enrichNode(first, { fetcher: async url => response(new URL(url).hostname === 'api.nuget.org'
    ? { versions: ['1.0.0'] } : {}) });
  assert.equal(first.vulnerabilityCount, 2);
  assert.deepEqual(second.advisories.map(advisory => advisory.id), ['configured']);
  assert.equal(second.vulnerabilityCount, 1);
  assert.equal(second.scan, 'findings');
  assert.equal(health(second, 'security'), 'critical');
});

test('NuGet queries preserve package spelling and empty results never imply case-insensitive coverage', async () => {
  const result = await enrichNode(nugetNode({ packageName: 'Newtonsoft.Json' }), { fetcher: async (url, options) => {
    if (new URL(url).hostname === 'api.nuget.org') return response({ versions: ['1.0.0'] });
    assert.deepEqual(JSON.parse(options.body).package, { name: 'Newtonsoft.Json', ecosystem: 'NuGet' });
    return response({});
  } });
  assert.equal(result.scan, 'limited coverage');
  assert.equal(health(result, 'security'), 'warning');
  assert.ok(result.checkedAt);
});
