import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/parser.js';
import { renderGraph } from '../src/iso-glow-adapter.js';

class SvgElement {
  attributes = new Map();
  children = [];
  style = {};
  listeners = new Map();

  constructor(tag) { this.tag = tag; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}

function render(graph, options = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElementNS: (_namespace, tag) => new SvgElement(tag) };
  try {
    const svg = new SvgElement('svg');
    renderGraph(svg, graph, {
      view: 'health', selected: undefined, affected: [], layer: 'all', search: '', zoom: 1,
      onSelect: () => {}, ...options,
    });
    return svg;
  } finally {
    globalThis.document = previousDocument;
  }
}

test('packages stay compact while services render as accessible two-band towers', () => {
  const graph = normalizeConfig({
    project: 'Mixed graph',
    dependencies: [{ name: 'library', ecosystem: 'NuGet', version: '1.2.3' }],
    services: [{ name: 'api', type: 'project', dependencies: ['library'] }],
  });
  const svg = render(graph);
  const packageNode = svg.children.find(node => node.getAttribute('class')?.includes('block package'));
  const serviceNode = svg.children.find(node => node.getAttribute('class')?.includes('block service'));
  assert.ok(packageNode);
  assert.ok(serviceNode);
  assert.match(packageNode.getAttribute('aria-label'), /library, package/);
  assert.match(serviceNode.getAttribute('aria-label'), /api, service/);
  assert.equal(packageNode.children.filter(node => node.tag === 'path').length, 4);
  const servicePaths = serviceNode.children.filter(node => node.tag === 'path');
  assert.equal(servicePaths.length, 7);
  const bands = servicePaths.find(node => node.getAttribute('class') === 'service-band');
  assert.equal((bands.getAttribute('d').match(/M /g) ?? []).length, 2);
  assert.equal(serviceNode.children.find(node => node.getAttribute('class') === 'plate').getAttribute('y'), '-43');
  assert.equal(serviceNode.children.find(node => node.getAttribute('class') === 'node-label').getAttribute('y'), '85');
  const edge = svg.children.flatMap(node => node.children)
    .find(node => node.getAttribute('class') === 'edge');
  assert.equal(edge.getAttribute('d'), 'M 485 199 L 335 148');
  assert.match(edge.getAttribute('aria-label'), /api depends on library/);
});

test('shape classes remain distinct when health colors change or nodes are filtered', () => {
  const graph = normalizeConfig({
    dependencies: [{ name: 'library', ecosystem: 'NuGet', version: '1.2.3' }],
    services: [{ name: 'api', status: 'warning', dependencies: ['library'] }],
  });
  const svg = render(graph, { view: 'security' });
  const packageNode = svg.children.find(node => node.getAttribute('class')?.includes('block package'));
  const serviceNode = svg.children.find(node => node.getAttribute('class')?.includes('block service'));
  assert.match(packageNode.getAttribute('class'), /warning/);
  assert.match(serviceNode.getAttribute('class'), /warning/);
  const filtered = render(graph, { layer: 'service' });
  assert.equal(filtered.children.filter(node => node.getAttribute('class')?.startsWith('block ')).length, 1);
  assert.ok(filtered.children.some(node => node.getAttribute('class')?.includes('block service')));
});

test('plan view colors actions and shows supplied resource icons without distorting them', () => {
  const graph = normalizeConfig({
    services: [{
      name: 'Microsoft.Storage/storageAccounts/data',
      planChange: 'create',
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    }],
  });
  const svg = render(graph, { view: 'plan' });
  const node = svg.children.find(child => child.getAttribute('class')?.includes('block service'));
  const icon = node.children.find(child => child.tag === 'image');

  assert.match(node.getAttribute('class'), /plan-create/);
  assert.match(node.getAttribute('aria-label'), /planned create/);
  assert.equal(icon.getAttribute('preserveAspectRatio'), 'xMidYMid meet');
  assert.equal(icon.getAttribute('href'), graph.nodes[0].icon);
  assert.equal(node.children.some(child => child.getAttribute('class') === 'plate'), false);
});
