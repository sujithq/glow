import { parseDocument } from 'yaml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const MAX_INPUT_BYTES = 1_000_000;
const statuses = new Set(['healthy', 'warning', 'critical']);
const nugetId = /^[A-Za-z0-9_.-]{1,100}$/;
const componentName = node => node.kind !== 'service' && node.ecosystem === 'NuGet'
  ? node.name?.toLowerCase() : node.name;
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
    const ecosystem = node.ecosystem ?? 'npm';
    if (!['npm', 'PyPI', 'NuGet'].includes(ecosystem)) throw new Error(`Unsupported ecosystem: ${ecosystem}`);
    if (node.kind === 'package' && ecosystem === 'NuGet' && !nugetId.test(node.name)) {
      throw new Error(`Invalid NuGet package ID: ${node.name}. Use 1–100 ASCII letters, digits, underscores, dots, or hyphens.`);
    }
    const name = componentName(node);
    const packageName = node.kind === 'package' && ecosystem === 'NuGet' ? node.packageName ?? node.name : undefined;
    if (packageName !== undefined && (typeof packageName !== 'string' || !nugetId.test(packageName) || packageName.toLowerCase() !== name)) {
      throw new Error(`NuGet packageName must match component ${name} case-insensitively.`);
    }
    if (names.has(name)) throw new Error(`Duplicate component: ${name}`);
    names.add(name);
    const status = node.status === 'running' ? 'healthy' : node.status ?? 'healthy';
    if (!statuses.has(status)) throw new Error(`Invalid status for ${node.name}.`);
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
      id: name, name, kind: node.kind, ecosystem,
      ...(packageName !== undefined ? { packageName } : {}),
      version: text(node.version), status, type: text(node.type, node.kind),
      description: text(node.description), license: text(node.license, 'Unknown'),
      repository: text(node.repository), deprecated: Boolean(node.deprecated),
      dependencies: [...new Set(refs)], advisories,
      vulnerabilityCount: Array.isArray(vulnerabilities) ? advisories.length : vulnerabilities,
      scan: 'not checked', errors: [],
    };
  });
  const nugetNames = new Set(nodes.filter(node => node.kind === 'package' && node.ecosystem === 'NuGet').map(node => node.name));
  const edges = [];
  for (const node of nodes) {
    node.dependencies = [...new Set(node.dependencies.map(ref =>
      names.has(ref) ? ref : nugetNames.has(ref.toLowerCase()) ? ref.toLowerCase() : ref))];
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

// This is a static manifest reader, not an MSBuild evaluator. Conditional,
// imported, central, and project references must be modeled explicitly in YAML.
function xmlElements(children) {
  return children.filter(child => {
    if ('#text' in child) {
      if (String(child['#text']).trim()) throw new Error('Unexpected text in XML manifest.');
      return false;
    }
    return true;
  });
}

function xmlName(element) {
  return Object.keys(element).find(key => key !== ':@');
}

function xmlAttributes(element, allowed) {
  const attrs = element[':@'] ?? {};
  for (const key of Object.keys(attrs)) {
    const name = key.slice(2);
    if (!allowed.includes(name)) throw new Error(`Unsupported XML attribute: ${name}. Conditional and imported MSBuild evaluation is not supported.`);
  }
  return Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key.slice(2), value]));
}

function xmlValue(element) {
  const children = element[xmlName(element)];
  if (children.some(child => !('#text' in child))) throw new Error('Version and property values must be plain XML text.');
  return children.map(child => child['#text']).join('').trim();
}

function projectVersion(value) {
  if (!value) return '*';
  if (value.includes('$(') || value.includes('*')) return value;
  const exact = value.match(/^\[\s*([^,[\]()]+)\s*\]$/);
  if (exact) return exact[1].trim();
  if (/^[[(]/.test(value)) return value;
  return `>=${value}`;
}

export function parseNugetManifest(source, filename) {
  // Comments and CDATA contain literal text, not declarations or entity references.
  const segments = source.split(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g);
  if (segments.some(segment => /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(segment) || /<\?(?!xml(?:\s|\?>))/i.test(segment))) {
    throw new Error('XML DOCTYPE, ENTITY, and processing instructions are not supported.');
  }
  const valid = XMLValidator.validate(source);
  if (valid !== true) throw new Error(`Invalid XML manifest: ${valid.err.msg}`);
  if (segments.some(segment => /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(segment))) {
    throw new Error('Unsupported XML entity reference.');
  }
  const parser = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    preserveOrder: true, trimValues: false, htmlEntities: true,
  });
  const roots = xmlElements(parser.parse(source)).filter(element => xmlName(element) !== '?xml');
  const packagesConfig = /(?:^|[/\\])packages\.config(?:-example)?$/i.test(filename);
  const rootName = packagesConfig ? 'packages' : 'Project';
  if (roots.length !== 1 || xmlName(roots[0]) !== rootName) throw new Error(`Expected a single ${rootName} XML root.`);
  const root = roots[0];
  xmlAttributes(root, packagesConfig ? [] : ['Sdk', 'ToolsVersion', 'DefaultTargets', 'xmlns']);
  const dependencies = [];
  if (packagesConfig) {
    for (const element of xmlElements(root.packages)) {
      if (xmlName(element) !== 'package') throw new Error('Only package elements are supported in packages.config.');
      const attrs = xmlAttributes(element, ['id', 'version', 'targetFramework', 'allowedVersions', 'developmentDependency', 'requireReinstallation']);
      if (xmlElements(element.package).length || !attrs.id || !attrs.version?.trim()) {
        throw new Error('Each packages.config package requires an id and explicit version, with no child elements.');
      }
      dependencies.push({ name: attrs.id, version: attrs.version.trim(), ecosystem: 'NuGet' });
    }
  } else {
    for (const group of xmlElements(root.Project)) {
      const name = xmlName(group);
      if (name === 'ProjectReference') throw new Error('ProjectReference is not a package; use explicit YAML service nodes.');
      if (!['PropertyGroup', 'ItemGroup'].includes(name)) throw new Error(`Unsupported MSBuild construct: ${name}. Imports and central package resolution are not supported.`);
      xmlAttributes(group, ['Label']);
      for (const element of xmlElements(group[name])) {
        const itemName = xmlName(element);
        if (itemName === 'ProjectReference') throw new Error('ProjectReference is not a package; use explicit YAML service nodes.');
        if (name === 'PropertyGroup') {
          xmlAttributes(element, []);
          if (['PackageReference', 'PackageVersion', 'ProjectReference', 'Import', 'ImportGroup', 'Choose', 'When', 'Otherwise', 'Target', 'ItemGroup'].includes(itemName)) {
            throw new Error(`Unsupported or misplaced MSBuild construct: ${itemName}.`);
          }
          if (['ManagePackageVersionsCentrally', 'CentralPackageVersionOverrideEnabled', 'CentralPackageTransitivePinningEnabled'].includes(itemName)) {
            throw new Error(`Unsupported central package resolution: ${itemName}.`);
          }
          xmlValue(element);
          continue;
        }
        if (itemName !== 'PackageReference') throw new Error(`Unsupported MSBuild item: ${itemName}. Only direct PackageReference items are supported.`);
        const attrs = xmlAttributes(element, ['Include', 'Version', 'VersionOverride', 'PrivateAssets', 'IncludeAssets', 'ExcludeAssets', 'Aliases', 'GeneratePathProperty', 'NoWarn']);
        if (!attrs.Include) throw new Error('PackageReference requires Include; Update and central resolution are not supported.');
        const versions = { Version: attrs.Version, VersionOverride: attrs.VersionOverride };
        for (const metadata of xmlElements(element.PackageReference)) {
          const key = xmlName(metadata);
          xmlAttributes(metadata, []);
          const value = xmlValue(metadata);
          if (key === 'Version' || key === 'VersionOverride') {
            if (versions[key] !== undefined) throw new Error(`Duplicate ${key} for ${attrs.Include}.`);
            versions[key] = value;
          } else if (!['PrivateAssets', 'IncludeAssets', 'ExcludeAssets', 'Aliases', 'GeneratePathProperty', 'NoWarn'].includes(key)) {
            throw new Error(`Unsupported PackageReference metadata: ${key}.`);
          }
        }
        dependencies.push({
          name: attrs.Include, ecosystem: 'NuGet',
          version: projectVersion((versions.VersionOverride ?? versions.Version)?.trim()),
        });
      }
    }
  }
  return normalizeConfig({ project: packagesConfig ? 'NuGet packages' : 'NuGet project', dependencies });
}

export function parseInput(source, filename = 'glow.config.yaml') {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_INPUT_BYTES) {
    throw new Error('Input must be text smaller than 1 MB.');
  }
  if (/\.csproj(?:-example)?$/i.test(filename) || /(?:^|[/\\])packages\.config(?:-example)?$/i.test(filename)) {
    return parseNugetManifest(source, filename);
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
        const count = data.nodes.find(original => componentName(original) === node.name).vulnerabilityCount;
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
