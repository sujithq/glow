import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseInput, affectedBy } from '../src/parser.js';

test('.NET tool YAML imports into the browser with projects, packages and reverse impact', {
  skip: !process.env.GLOW_CLI_DLL && 'Set GLOW_CLI_DLL to a built Glow.Cli.dll to run interoperability coverage.',
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'glow-interop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dll = path.resolve(process.env.GLOW_CLI_DLL);
  for (const name of ['App', 'Core']) {
    const directory = path.join(root, name);
    const projectPath = path.join(directory, `${name}.csproj`);
    const corePath = path.join(root, 'Core', 'Core.csproj');
    await mkdir(path.join(directory, 'obj'), { recursive: true });
    await writeFile(projectPath, 'Not evaluated by the converter.');
    const libraries = {
      'True/1.0.0': { type: 'package', dependencies: { 'Logging.Abstractions': '1.2.0' } },
      'Logging.Abstractions/1.2.0': { type: 'package' },
      'Other/2.0.0': { type: 'package' },
    };
    const metadata = Object.fromEntries(Object.keys(libraries).map(key => [key, { type: 'package' }]));
    if (name === 'App') {
      libraries['Core/1.0.0'] = { type: 'project' };
      metadata['Core/1.0.0'] = { type: 'project', msbuildProject: '../Core/Core.csproj' };
    }
    await writeFile(path.join(directory, 'obj', 'project.assets.json'), JSON.stringify({
      version: 3,
      targets: { 'net10.0': libraries },
      libraries: metadata,
      project: {
        restore: {
          projectPath,
          frameworks: { 'net10.0': {
            projectReferences: name === 'App' ? { [corePath]: { projectPath: corePath } } : {},
          } },
        },
        frameworks: { 'net10.0': {
          targetAlias: 'net10.0',
          dependencies: name === 'Core' ? { True: { target: 'Package' } } : {},
        } },
      },
    }));
  }
  for (const extension of ['sln', 'slnx']) {
    const solution = path.join(root, `Sample.${extension}`);
    await writeFile(solution, extension === 'sln'
      ? 'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "App\\App.csproj", "{id}"\nEndProject'
      : '<Solution><Project Path="App/App.csproj" /></Solution>');
    const output = path.join(root, `${extension}.yaml`);
    const result = spawnSync('dotnet', [dll, 'convert', solution, '-o', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const yaml = await readFile(output, 'utf8');
    const graph = parseInput(yaml);
    assert.equal(graph.project, 'Sample');
    assert.equal(graph.nodes.length, 5);
    assert.deepEqual(graph.edges, [
      { source: 'true', target: 'logging.abstractions' },
      { source: 'project:App/App.csproj', target: 'project:Core/Core.csproj' },
      { source: 'project:Core/Core.csproj', target: 'true' },
    ]);
    assert.equal(graph.nodes.find(node => node.id === 'true').packageName, 'True');
    assert.equal(graph.nodes.find(node => node.id === 'true').version, '1.0.0');
    assert.deepEqual(affectedBy(graph, 'logging.abstractions').sort(),
      ['project:App/App.csproj', 'project:Core/Core.csproj', 'true']);
    assert.ok(graph.nodes.every(node => node.scan === 'not checked'));
    assert.ok(!yaml.includes(root));
    const overwrite = spawnSync('dotnet', [dll, 'convert', solution, '-o', output], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.equal(await readFile(output, 'utf8'), yaml);
  }
});
