import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { convertSolution } from '../src/solution-converter.js';
import { parseInput, affectedBy } from '../src/parser.js';

const cli = fileURLToPath(new URL('../cli/glow-solution.js', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'glow-solution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function project(name, { packages = {}, direct = [], references = [], version = 3 } = {}) {
    const filename = path.join(root, name, `${path.basename(name)}.csproj`);
    const assetsPath = path.join(path.dirname(filename), 'obj', 'project.assets.json');
    await mkdir(path.dirname(assetsPath), { recursive: true });
    await writeFile(filename, '<Project Sdk="Microsoft.NET.Sdk" />');
    const target = { ...packages };
    const libraries = Object.fromEntries(Object.keys(packages).map(key => [key, { type: 'package' }]));
    const projectReferences = {};
    for (const reference of references) {
      const referencePath = path.join(root, reference, `${path.basename(reference)}.csproj`);
      const key = `${path.basename(reference)}/1.0.0`;
      target[key] = { type: 'project' };
      libraries[key] = { type: 'project', msbuildProject: path.relative(path.dirname(filename), referencePath) };
      projectReferences[referencePath] = { projectPath: referencePath };
    }
    const assets = {
      version, targets: { 'net8.0': target }, libraries,
      project: {
        restore: { projectPath: filename, frameworks: { 'net8.0': { projectReferences } } },
        frameworks: { 'net8.0': {
          targetAlias: 'net8.0',
          dependencies: Object.fromEntries(direct.map(name => [name, { target: 'Package', version: '[1.0.0, )' }])),
        } },
      },
    };
    await writeFile(assetsPath, JSON.stringify(assets));
    return { filename, assets, assetsPath };
  }
  async function solution(projects, format = 'slnx') {
    const filename = path.join(root, `Sample.${format}`);
    const filenames = projects.map(name => `${name}/${path.basename(name)}.csproj`);
    const source = format === 'slnx'
      ? `<Solution><Folder Name="/src/">${filenames.map(name => `<Project Path="${name}" />`).join('')}</Folder></Solution>`
      : 'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{folder}"\nEndProject\n' +
        filenames.map(name => `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Project", "${name.replaceAll('/', '\\')}", "{id}"\nEndProject`).join('\n');
    await writeFile(filename, source);
    return filename;
  }
  return { root, project, solution };
}

for (const format of ['sln', 'slnx']) {
  test(`${format} converts projects, direct packages, transitive edges and external project references`, async t => {
    const f = await fixture(t);
    const packages = {
      'Logging/2.1.0': { type: 'package', dependencies: { 'Logging.Abstractions': '1.2.0' } },
      'Logging.Abstractions/1.2.0': { type: 'package' },
    };
    await f.project('src/Core', { packages, direct: ['Logging'], version: 4 });
    await f.project('App', { packages, references: ['src/Core'] });
    const filename = await f.solution(['App'], format);
    const yaml = await convertSolution(filename);
    const graph = parseInput(yaml);
    assert.equal(graph.project, 'Sample');
    assert.equal(graph.nodes.length, 4);
    assert.deepEqual(graph.edges, [
      { source: 'logging', target: 'logging.abstractions' },
      { source: 'project:App/App.csproj', target: 'project:src/Core/Core.csproj' },
      { source: 'project:src/Core/Core.csproj', target: 'logging' },
    ]);
    assert.equal(graph.nodes.find(node => node.id === 'logging').packageName, 'Logging');
    assert.equal(graph.nodes.find(node => node.id === 'logging').version, '2.1.0');
    assert.deepEqual(affectedBy(graph, 'logging.abstractions').sort(),
      ['logging', 'project:App/App.csproj', 'project:src/Core/Core.csproj']);
    assert.ok(graph.nodes.every(node => node.scan === 'not checked'));
    assert.ok(!yaml.includes(f.root));
    assert.equal(await convertSolution(filename), yaml);
  });
}

test('keeps identically named projects in different directories distinct and deduplicates solution entries', async t => {
  const f = await fixture(t);
  await f.project('one/Common');
  await f.project('two/Common');
  const graph = parseInput(await convertSolution(await f.solution(['one/Common', 'two/Common', 'one/Common'])));
  assert.deepEqual(graph.nodes.map(node => node.id), [
    'project:one/Common/Common.csproj', 'project:two/Common/Common.csproj',
  ]);
});

test('requires an explicit target for multitarget/RID graphs and preserves target-specific dependencies', async t => {
  const f = await fixture(t);
  const p = await f.project('App');
  p.assets.targets['net8.0/linux-x64'] = { 'Runtime.Native/2.0.0': { type: 'package' } };
  p.assets.libraries['Runtime.Native/2.0.0'] = { type: 'package' };
  p.assets.targets['net9.0'] = {};
  p.assets.project.frameworks['net9.0'] = { targetAlias: 'net9.0' };
  p.assets.project.restore.frameworks['net9.0'] = { projectReferences: {} };
  await writeFile(p.assetsPath, JSON.stringify(p.assets));
  const filename = await f.solution(['App']);
  await assert.rejects(convertSolution(filename), /multiple restore targets.*--target.*net8.0\/linux-x64/);
  assert.equal(parseInput(await convertSolution(filename, { target: 'net8.0' })).nodes.length, 1);
  assert.equal(parseInput(await convertSolution(filename, { target: 'net8.0/linux-x64' })).nodes.length, 2);
  await assert.rejects(convertSolution(filename, { target: 'missing' }), /not found/);
  await assert.rejects(convertSolution(filename, { target: '' }), /nonempty restore target/);
});

test('an explicit target cannot silently select another target in a referenced project', async t => {
  const f = await fixture(t);
  await f.project('App', { references: ['Core'] });
  const core = await f.project('Core');
  core.assets.targets = { 'net9.0': {} };
  core.assets.project.frameworks = { 'net9.0': { targetAlias: 'net9.0' } };
  core.assets.project.restore.frameworks = { 'net9.0': { projectReferences: {} } };
  await writeFile(core.assetsPath, JSON.stringify(core.assets));
  const filename = await f.solution(['App']);
  assert.equal(parseInput(await convertSolution(filename)).nodes.length, 2);
  await assert.rejects(convertSolution(filename, { target: 'net8.0' }), /Core.*target "net8.0" not found.*net9.0/);
});

test('rejects conflicting package versions across projects instead of collapsing them', async t => {
  const f = await fixture(t);
  await f.project('App', { packages: { 'Logging/1.0.0': { type: 'package' } }, direct: ['Logging'] });
  await f.project('Core', { packages: { 'logging/2.0.0': { type: 'package' } }, direct: ['logging'] });
  await assert.rejects(convertSolution(await f.solution(['App', 'Core'])), /Conflicting versions.*1.0.0 and 2.0.0/);
});

test('rejects absent, malformed, failed, foreign and unsupported restore assets', async t => {
  const f = await fixture(t);
  const p = await f.project('App');
  const filename = await f.solution(['App']);
  await rm(p.assetsPath);
  await assert.rejects(convertSolution(filename), /dotnet restore/);
  await writeFile(p.assetsPath, '{');
  await assert.rejects(convertSolution(filename), SyntaxError);
  const invalid = [
    [{ ...p.assets, version: 99 }, /unsupported restore assets version/],
    [{ ...p.assets, logs: [{ level: 'Error' }] }, /restore assets contain errors/],
    [{ ...p.assets, targets: {} }, /restore targets.*none/],
    [{ ...p.assets, libraries: null }, /library metadata/],
    [{ ...p.assets, targets: { 'net8.0': { 'Unsupported/1.0.0': { type: 'reference' } } } }, /unsupported restored library type/],
    [{ ...p.assets, targets: { 'net8.0': { 'Project/1.0.0': { type: 'project' } } } }, /missing project path/],
    [{ ...p.assets, project: { ...p.assets.project, frameworks: {} } }, /missing framework metadata/],
    [{ ...p.assets, project: { ...p.assets.project, restore: {
      ...p.assets.project.restore, frameworks: {},
    } } }, /missing project-reference metadata/],
    [{ ...p.assets, project: { ...p.assets.project, restore: {
      ...p.assets.project.restore, projectPath: filename,
    } } }, /different project/],
  ];
  for (const [assets, message] of invalid) {
    await writeFile(p.assetsPath, JSON.stringify(assets));
    await assert.rejects(convertSolution(filename), message);
  }
});

test('rejects dangling package dependencies and missing project assets', async t => {
  const f = await fixture(t);
  const p = await f.project('App', {
    packages: { 'Logging/1.0.0': { type: 'package', dependencies: { Missing: '1.0.0' } } },
    direct: ['Logging'],
  });
  const filename = await f.solution(['App']);
  await assert.rejects(convertSolution(filename), /Missing.*missing from the selected restore target/);
  p.assets.project.frameworks['net8.0'].dependencies = { Missing: { target: 'Package' } };
  p.assets.targets['net8.0'] = {};
  await writeFile(p.assetsPath, JSON.stringify(p.assets));
  await assert.rejects(convertSolution(filename), /Missing.*missing from the selected restore target/);
  await f.project('Core', { references: ['App'] });
  await rm(p.assetsPath);
  await assert.rejects(convertSolution(await f.solution(['Core'])), /dotnet restore/);
});

test('handles cycles in restored project references', async t => {
  const f = await fixture(t);
  await f.project('App', { references: ['Core'] });
  await f.project('Core', { references: ['App'] });
  const graph = parseInput(await convertSolution(await f.solution(['App'])));
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 2);
});

test('validates the generated configuration against browser component and size limits', async t => {
  const f = await fixture(t);
  await f.project('App', { packages: Object.fromEntries(Array.from({ length: 300 },
    (_, index) => [`Package${index}/1.0.0`, { type: 'package' }])) });
  const filename = await f.solution(['App']);
  await assert.rejects(convertSolution(filename), /300 components/);
  const packages = Object.fromEntries(Array.from({ length: 299 }, (_, index) => {
    const name = `Package${String(index).padStart(3, '0')}${'x'.repeat(85)}`;
    return [`${name}/1.0.0`, { type: 'package' }];
  }));
  const dependencies = Object.fromEntries(Object.keys(packages).map(key => [key.split('/')[0], '1.0.0']));
  for (const library of Object.values(packages)) library.dependencies = dependencies;
  await f.project('App', { packages });
  await assert.rejects(convertSolution(filename), /1 MB/);
});

test('rejects unsupported solution input, malformed XML, entities and unsupported project types', async t => {
  const f = await fixture(t);
  await assert.rejects(convertSolution(path.join(f.root, 'test.csproj')), /\.sln or .slnx/);
  const filename = path.join(f.root, 'Bad.slnx');
  for (const [source, message] of [
    ['<Solution>', /Invalid .slnx/],
    ['<!DOCTYPE Solution [<!ENTITY file SYSTEM "file:///secret">]><Solution />', /DTD/],
    ['<NotSolution />', /Solution XML root/],
    ['<Solution />', /no supported projects/],
    ['<Solution><Project /></Solution>', /requires a Path/],
    ['<Solution><Project Path="native.vcxproj" /></Solution>', /Unsupported project/],
  ]) {
    await writeFile(filename, source);
    await assert.rejects(convertSolution(filename), message);
  }
  const sln = path.join(f.root, 'Bad.sln');
  await writeFile(sln, 'not a solution');
  await assert.rejects(convertSolution(sln), /Invalid .sln/);
});

test('CLI generates an uploadable file, refuses overwrite and returns errors without writing output', async t => {
  const f = await fixture(t);
  await f.project('App');
  const filename = await f.solution(['App']);
  const output = path.join(f.root, 'my config.yaml');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8' });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(run([filename, '--output', output]).status, 0);
  const yaml = await readFile(output, 'utf8');
  assert.equal(parseInput(yaml).nodes.length, 1);
  const overwrite = run([filename, '-o', output]);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), yaml);
  assert.equal(run([filename]).status, 0);
  assert.equal(parseInput(await readFile(path.join(f.root, 'glow.config.yaml'), 'utf8')).nodes.length, 1);
  for (const args of [[], [filename, 'extra'], ['--unknown'], [filename, '--target', 'missing']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Glow conversion failed:/);
  }
});
