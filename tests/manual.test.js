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

test('manual CLI installation follows the latest release without a pinned version', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="manual-cli">/);
  assert.match(html, /href="#manual-cli"/);
  assert.ok(html.includes('https://github.com/sujithq/glow/releases/latest'));
  assert.ok(html.includes('https://api.github.com/repos/sujithq/glow/releases/latest'));
  assert.doesNotMatch(html, /cli-v\d|--version \d|Glow\.Cli\.\d/, 'Release versions are not hard-coded');
  assert.match(html, /dotnet tool install --global Glow\.Cli --source \.\\glow-release --framework net10\.0/);
  assert.match(html, /glow convert main\.json --what-if what-if\.json/);
});
