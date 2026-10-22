import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { stringify } from 'yaml';
import { parseInput } from './parser.js';

const nativePath = value => value.replace(/[/\\]/g, path.sep);
const resolvePath = (directory, value) => path.resolve(directory, nativePath(value));
const displayPath = value => value.split(path.sep).join('/');
const entries = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return Object.entries(value);
};

async function readSolution(filename) {
  const source = await readFile(filename, 'utf8');
  const projects = [];
  if (/\.sln$/i.test(filename)) {
    if (!source.includes('Microsoft Visual Studio Solution File')) throw new Error('Invalid .sln file.');
    for (const line of source.split(/\r?\n/)) {
      if (!/^\s*Project\(/.test(line)) continue;
      const match = line.match(/^\s*Project\("([^"]+)"\)\s*=\s*"[^"]*",\s*"([^"]+)",\s*"[^"]+"\s*$/);
      if (!match) throw new Error(`Invalid solution project entry: ${line.trim()}`);
      if (match[1].toUpperCase() !== '{2150E333-8FDC-42A3-9474-1A3956D46DE8}') projects.push(match[2]);
    }
  } else {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Solution XML declarations of DTDs/entities are not supported.');
    const valid = XMLValidator.validate(source);
    if (valid !== true) throw new Error(`Invalid .slnx XML: ${valid.err.msg}`);
    const document = new XMLParser({ ignoreAttributes: false, preserveOrder: true }).parse(source);
    const roots = document.filter(element => !['?xml', '#text', '#comment'].includes(Object.keys(element)[0]));
    if (roots.length !== 1 || !roots[0].Solution) throw new Error('Expected a single Solution XML root.');
    function visit(elements) {
      for (const element of elements) {
        if (element.Project) {
          const project = element[':@']?.['@_Path'];
          if (typeof project !== 'string' || !project.trim()) throw new Error('Each solution Project requires a Path.');
          projects.push(project);
        }
        for (const [key, children] of Object.entries(element)) {
          if (key !== ':@' && Array.isArray(children)) visit(children);
        }
      }
    }
    visit(roots[0].Solution);
  }
  if (!projects.length) throw new Error('Solution contains no supported projects.');
  for (const project of projects) {
    if (!/\.(cs|fs|vb)proj$/i.test(project)) {
      throw new Error(`Unsupported project ${project}; only SDK-style C#, F#, and Visual Basic restore assets are supported.`);
    }
  }
  return projects.map(project => resolvePath(path.dirname(filename), project));
}

function selectTarget(assets, requested, project) {
  const targets = entries(assets.targets, `${project} restore targets`);
  const selected = requested ? targets.find(([name]) => name === requested) : targets.length === 1 ? targets[0] : undefined;
  if (!selected) {
    throw new Error(`${project}: ${requested ? `target "${requested}" not found` : 'multiple restore targets'}. ` +
      `Use --target with one of: ${targets.map(([name]) => name).join(', ') || '(none)'}.`);
  }
  const frameworkName = selected[0].split('/')[0];
  const frameworks = entries(assets.project?.frameworks, `${project} framework metadata`);
  const framework = frameworks.find(([name, value]) => name === frameworkName || value.targetAlias === frameworkName);
  if (!framework) throw new Error(`${project}: missing framework metadata for ${selected[0]}.`);
  const alias = framework[1].targetAlias ?? framework[0];
  const restoreFrameworks = entries(assets.project?.restore?.frameworks, `${project} project-reference metadata`);
  const restoreFramework = restoreFrameworks.find(([name, value]) =>
    name === framework[0] || name === alias || value.targetAlias === alias);
  if (!restoreFramework) throw new Error(`${project}: missing project-reference metadata for ${selected[0]}.`);
  return { name: selected[0], libraries: selected[1], framework: framework[1], restoreFramework: restoreFramework[1] };
}

function libraryIdentity(key) {
  const separator = key.lastIndexOf('/');
  if (separator <= 0 || separator === key.length - 1) throw new Error(`Invalid restored library identity: ${key}`);
  return { name: key.slice(0, separator), version: key.slice(separator + 1) };
}

/** Convert existing local restore artifacts; never execute projects or contact feeds. */
export async function convertSolution(filename, { target } = {}) {
  if (!/\.(sln|slnx)$/i.test(filename)) throw new Error('Input must be a .sln or .slnx file.');
  if (target !== undefined && (typeof target !== 'string' || !target.trim())) throw new Error('Target must be a nonempty restore target key.');
  const solution = await realpath(filename);
  const directory = path.dirname(solution);
  const projects = new Map();
  const packages = new Map();

  async function loadProject(projectPath) {
    const filename = await realpath(projectPath);
    if (projects.has(filename)) return projects.get(filename);
    if (!/\.(cs|fs|vb)proj$/i.test(filename)) throw new Error(`Unsupported referenced project: ${filename}`);
    const relative = displayPath(path.relative(directory, filename));
    const name = `project:${relative}`;
    const assetsPath = path.join(path.dirname(filename), 'obj', 'project.assets.json');
    let source;
    try {
      source = await readFile(assetsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing ${assetsPath}. Run dotnet restore on the solution first (default obj path required).`);
      throw error;
    }
    const assets = JSON.parse(source);
    if (![3, 4].includes(assets.version)) throw new Error(`${relative}: unsupported restore assets version ${assets.version}.`);
    if (assets.logs?.some(log => log.level?.toLowerCase() === 'error')) {
      throw new Error(`${relative}: restore assets contain errors. Complete a successful dotnet restore first.`);
    }
    const restoredPath = assets.project?.restore?.projectPath;
    if (typeof restoredPath !== 'string' || await realpath(resolvePath(path.dirname(filename), restoredPath)) !== filename) {
      throw new Error(`${relative}: restore assets belong to a different project. Restore locally first.`);
    }
    const selected = selectTarget(assets, target, relative);
    entries(assets.libraries, `${relative} library metadata`);
    const project = {
      name, type: 'project', description: `${relative} (restore target: ${selected.name})`,
      dependencies: new Set(), selected, resolved: new Map(),
    };
    projects.set(filename, project);
    for (const [key, library] of entries(selected.libraries, `${relative} target libraries`)) {
      const identity = libraryIdentity(key);
      const id = identity.name.toLowerCase();
      if (project.resolved.has(id)) throw new Error(`${relative}: duplicate restored library ${identity.name}.`);
      if (library.type === 'package') {
        let node = packages.get(id);
        if (node && node.version !== identity.version) {
          throw new Error(`Conflicting versions for ${identity.name}: ${node.version} and ${identity.version}. ` +
            'Glow supports only one version per package; convert a smaller solution or align versions.');
        }
        if (!node) {
          node = { name: identity.name, version: identity.version, ecosystem: 'NuGet', dependencies: new Set() };
          packages.set(id, node);
        }
        project.resolved.set(id, { name: id, library, node });
      } else if (library.type === 'project') {
        const metadata = assets.libraries[key];
        const reference = metadata?.msbuildProject ?? metadata?.path;
        if (typeof reference !== 'string') throw new Error(`${relative}: missing project path for ${key}.`);
        const referenced = await loadProject(resolvePath(path.dirname(filename), reference));
        project.resolved.set(id, { name: referenced.name, library });
      } else {
        throw new Error(`${relative}: unsupported restored library type for ${key}: ${library.type}.`);
      }
    }
    for (const [reference, metadata] of entries(selected.restoreFramework.projectReferences ?? {}, `${relative} project references`)) {
      const referenced = await loadProject(resolvePath(path.dirname(filename), metadata.projectPath ?? reference));
      project.dependencies.add(referenced.name);
    }
    return project;
  }

  for (const filename of await readSolution(solution)) await loadProject(filename);
  for (const project of projects.values()) {
    const resolveDependency = name => {
      const resolved = project.resolved.get(name.toLowerCase());
      if (!resolved) throw new Error(`${project.name}: dependency ${name} is missing from the selected restore target.`);
      return resolved;
    };
    for (const [name, dependency] of entries(project.selected.framework.dependencies ?? {}, `${project.name} direct dependencies`)) {
      if (dependency.target !== 'Package') throw new Error(`${project.name}: unsupported direct dependency ${name}.`);
      project.dependencies.add(resolveDependency(name).name);
    }
    for (const { library, node } of project.resolved.values()) {
      for (const [name] of entries(library.dependencies ?? {}, `${project.name} library dependencies`)) {
        const dependency = resolveDependency(name);
        if (node) node.dependencies.add(dependency.name);
      }
    }
  }
  const sort = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const serialize = node => ({ ...node, dependencies: [...node.dependencies].sort() });
  const config = {
    project: path.basename(solution, path.extname(solution)),
    dependencies: [...packages.values()].sort(sort).map(serialize),
    services: [...projects.values()].sort(sort).map(({ name, type, description, dependencies }) =>
      serialize({ name, type, description, dependencies })),
  };
  const yaml = stringify(config);
  parseInput(yaml);
  return yaml;
}
