import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInput, normalizeConfig, affectedBy, health } from '../src/parser.js';

test('all shipped examples parse with valid relationships', async () => {
  for (const file of ['glow.config.yaml', 'healthy.config.yaml', 'vulnerable.config.yaml', 'package.json-example', 'requirements.txt-example']) {
    const graph = parseInput(await readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8'), file);
    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.target)));
  }
});
test('package manifests preserve version ranges and deduplicate groups', () => {
  const graph = parseInput(JSON.stringify({ dependencies: { react: '^18.0.0' }, devDependencies: { react: '18.2.0', test: '1.0.0' } }), 'package.json');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].version, '^18.0.0');
});
test('requirements pins, extras, normalized names, and ranges', () => {
  const graph = parseInput('My_Package[extra]==1.2.3 # pin\nFlask>=2.0,<4.0\nrequests', 'requirements.txt');
  assert.deepEqual(graph.nodes.map(node => [node.name, node.version]), [
    ['my-package', '1.2.3'], ['flask', '>=2.0,<4.0'], ['requests', '*'],
  ]);
  for (const source of ['-r secrets.txt', 'foo @ https://example.com/foo', 'foo==1.0; python_version>"3"']) {
    assert.throws(() => parseInput(source, 'requirements.txt'), /Unsupported requirement/);
  }
});
test('rejects malformed configs, duplicate names, unknown edges, and YAML aliases', () => {
  for (const source of ['[a, b]', 'dependencies: nope', 'dependencies:\n- name: a\n- name: a', 'dependencies:\n- name: a\n  dependencies: [missing]', 'dependencies:\n- name: a\n  status: bogus', 'dependencies: &a [*a]']) {
    assert.throws(() => parseInput(source));
  }
  assert.throws(() => parseInput('a'.repeat(1_000_001)), /1 MB/);
  assert.throws(() => normalizeConfig({ dependencies: Array.from({ length: 301 }, (_, i) => ({ name: `${i}` })) }), /300/);
  assert.throws(() => parseInput('project: one\nproject: two'), /unique/);
});
test('impact traversal handles cycles and finds transitive dependents', () => {
  const graph = normalizeConfig({ dependencies: [
    { name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['a'] },
  ], services: [{ name: 'api', dependencies: ['a'] }] });
  assert.deepEqual(affectedBy(graph, 'b').sort(), ['a', 'api']);
});
test('security never treats unscanned components as cleared', () => {
  const [node] = normalizeConfig({ dependencies: [{ name: 'test' }] }).nodes;
  assert.equal(health(node), 'healthy');
  assert.equal(health(node, 'security'), 'warning');
  assert.equal(health({ ...node, scan: 'clean' }, 'security'), 'healthy');
  assert.equal(health({ ...node, vulnerabilityCount: 1 }), 'critical');
  assert.equal(health({ ...node, errors: ['offline'] }), 'warning');
});
test('JSON snapshots retain findings but never reuse previous scan clearance', () => {
  const graph = normalizeConfig({ dependencies: [
    { name: 'a', vulnerabilities: [{ id: 'CVE-2025-12345' }] },
    { name: 'b', vulnerabilities: 3 },
  ] });
  graph.nodes[0].scan = 'clean';
  graph.nodes[0].vulnerabilityCount = 2;
  const restored = parseInput(JSON.stringify(graph), 'glow-report.json');
  assert.equal(restored.nodes[0].scan, 'not checked');
  assert.equal(restored.nodes[0].advisories[0].id, 'CVE-2025-12345');
  assert.equal(restored.nodes[0].vulnerabilityCount, 2);
  assert.equal(restored.nodes[1].vulnerabilityCount, 3);
});
