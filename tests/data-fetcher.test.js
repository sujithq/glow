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
