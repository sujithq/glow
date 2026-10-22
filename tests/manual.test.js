import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInput, affectedBy } from '../src/parser.js';

test('built-in manual has navigation and a working connected YAML example', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /href="#manual"/);
  assert.match(html, /id="manual"[^>]*aria-labelledby="manual-title"/);
  assert.match(html, /id="manual-title">End-user manual/);
  assert.match(html, /href="#dashboard"/);
  assert.match(html, /id="dashboard"/);

  const example = html.match(/<code id="manual-example">([\s\S]*?)<\/code>/);
  assert.ok(example, 'Manual provides a paste-ready configuration');
  const graph = parseInput(example[1], 'glow.config.yaml');
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(new Set(affectedBy(graph, 'shared-library')), new Set(['api', 'web']));
});

test('manual CLI installation matches the package version and links to its release', async () => {
  const [html, project] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../tools/Glow.Cli/Glow.Cli.csproj', import.meta.url), 'utf8'),
  ]);
  const version = project.match(/<Version>([^<]+)<\/Version>/)?.[1];
  assert.ok(version);
  assert.match(html, /<details id="manual-cli">/);
  assert.match(html, /href="#manual-cli"/);
  assert.ok(html.includes(`https://github.com/sujithq/glow/releases/tag/cli-v${version}`));
  assert.ok(html.includes(`/releases/download/cli-v${version}/Glow.Cli.${version}.nupkg`));
  assert.ok(html.includes(`--version ${version} --framework net10.0`));
  assert.match(html, /dotnet tool install --global Glow\.Cli --source/);
  assert.match(html, /glow convert main\.json --what-if what-if\.json/);
});
