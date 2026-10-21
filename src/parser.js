import { parseDocument } from 'yaml';

export const MAX_INPUT_BYTES = 1_000_000;
const statuses = new Set(['healthy', 'warning', 'critical']);
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const list = (value, field) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
};

export function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuration must be an object.');
  }
  const dependencies = list(config.dependencies, 'dependencies');
  const services = list(config.services, 'services');
  if (dependencies.length + services.length > 300) throw new Error('Maximum 300 components.');
  const names = new Set();
  const nodes = [...dependencies.map(node => ({ ...node, kind: 'package' })),
    ...services.map(node => ({ ...node, kind: 'service' }))].map(node => {
    if (!node.name || typeof node.name !== 'string' || node.name.length > 200) {
      throw new Error('Each component needs a name (maximum 200 characters).');
    }
    if (names.has(node.name)) throw new Error(`Duplicate component: ${node.name}`);
    names.add(node.name);
    const status = node.status === 'running' ? 'healthy' : node.status ?? 'healthy';
    if (!statuses.has(status)) throw new Error(`Invalid status for ${node.name}.`);
    const ecosystem = node.ecosystem ?? 'npm';
    if (!['npm', 'PyPI'].includes(ecosystem)) throw new Error(`Unsupported ecosystem: ${ecosystem}`);
    const refs = list(node.dependencies, `${node.name}.dependencies`);
    if (refs.some(ref => typeof ref !== 'string')) throw new Error('Dependency references must be names.');
    const vulnerabilities = node.vulnerabilities ?? [];
    if (!(Number.isSafeInteger(vulnerabilities) && vulnerabilities >= 0) && !Array.isArray(vulnerabilities)) {
      throw new Error('vulnerabilities must be a non-negative count or array.');
    }
    const advisories = Array.isArray(vulnerabilities) ? vulnerabilities.map(item => {
      if (!item || typeof item.id !== 'string') throw new Error('Each advisory requires an id.');
      return { id: item.id, summary: text(item.summary), severity: text(item.severity, 'unknown') };
    }) : [];
    return {
      id: node.name, name: node.name, kind: node.kind, ecosystem,
      version: text(node.version), status, type: text(node.type, node.kind),
      description: text(node.description), license: text(node.license, 'Unknown'),
      repository: text(node.repository), deprecated: Boolean(node.deprecated),
      dependencies: [...new Set(refs)], advisories,
      vulnerabilityCount: Array.isArray(vulnerabilities) ? advisories.length : vulnerabilities,
      scan: 'not checked', errors: [],
    };
  });
  const edges = [];
  for (const node of nodes) {
    for (const target of node.dependencies) {
      if (!names.has(target)) throw new Error(`${node.name} references unknown component ${target}.`);
      edges.push({ source: node.id, target });
    }
  }
  if (!nodes.length) throw new Error('Add at least one dependency or service.');
  return { project: text(config.project, 'My project'), nodes, edges };
}

export function parsePackageJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid package.json.');
  const packages = new Map();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const values = data[group] ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid ${group}.`);
    for (const [name, version] of Object.entries(values)) {
      if (typeof version !== 'string') throw new Error(`Invalid version for ${name}.`);
      if (!packages.has(name) || group === 'optionalDependencies') packages.set(name, { name, version, type: group });
    }
  }
  return normalizeConfig({ project: data.name, dependencies: [...packages.values()] });
}

export function parseRequirements(source) {
  const dependencies = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?\s*(?:(===|==|~=|>=|<=|!=|>|<)\s*([A-Za-z0-9.*+!_-]+(?:\.[A-Za-z0-9*+!_-]+)*)(?:\s*,\s*(?:~=|>=|<=|!=|>|<|==)\s*[A-Za-z0-9.*+!_-]+)*)?$/);
    if (!match) throw new Error(`Unsupported requirement: ${line}. Use package names or version specifiers; no URLs, includes, or markers.`);
    const name = match[1].toLowerCase().replace(/[-_.]+/g, '-');
    const specifier = line.slice(line.indexOf(']') >= 0 ? line.indexOf(']') + 1 : match[1].length).trim();
    dependencies.push({ name, ecosystem: 'PyPI',
      version: match[2] === '==' && !specifier.includes(',') && !match[3].includes('*') ? match[3] : specifier || '*' });
  }
  return normalizeConfig({ project: 'Python project', dependencies });
}

export function parseInput(source, filename = 'glow.config.yaml') {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_INPUT_BYTES) {
    throw new Error('Input must be text smaller than 1 MB.');
  }
  if (/requirements.*(?:txt|example)$/i.test(filename)) return parseRequirements(source);
  if (/\.json(?:-example)?$/i.test(filename)) {
    const data = JSON.parse(source);
    if (Array.isArray(data?.nodes)) {
      const nodes = data.nodes.map(node => ({
        ...node,
        vulnerabilities: node.advisories?.length ? node.advisories : node.vulnerabilityCount ?? 0,
      }));
      const graph = normalizeConfig({
        project: data.project,
        dependencies: nodes.filter(node => node.kind !== 'service'),
        services: nodes.filter(node => node.kind === 'service'),
      });
      for (const node of graph.nodes) {
        const count = data.nodes.find(original => original.name === node.name).vulnerabilityCount;
        if (count !== undefined) {
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid snapshot vulnerability count.');
          node.vulnerabilityCount = Math.max(node.vulnerabilityCount, count);
        }
      }
      return graph;
    }
    return data?.project !== undefined ? normalizeConfig(data) : parsePackageJson(data);
  }
  const document = parseDocument(source, { uniqueKeys: true, customTags: [] });
  if (document.errors.length) throw new Error(document.errors[0].message);
  return normalizeConfig(document.toJS({ maxAliasCount: 0 }));
}

export function health(node, view = 'health') {
  if (view === 'dependency') return 'healthy';
  if (node.vulnerabilityCount > 0) return 'critical';
  if (view === 'security') return node.scan === 'clean' ? 'healthy' : 'warning';
  if (node.status === 'critical') return 'critical';
  return node.status === 'warning' || node.deprecated || node.updateAvailable || node.errors.length ? 'warning' : 'healthy';
}

export function affectedBy(graph, id) {
  const affected = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (affected.has(edge.target) && !affected.has(edge.source)) {
        affected.add(edge.source);
        changed = true;
      }
    }
  }
  affected.delete(id);
  return [...affected];
}
