import { health } from './parser.js';

const NS = 'http://www.w3.org/2000/svg';
export function svgElement(tag, attributes = {}, content) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}

export function renderGraph(svg, graph, { view, selected, affected, layer, search, zoom, onSelect }) {
  svg.replaceChildren();
  const nodes = graph.nodes.filter(node => (layer === 'all' || node.kind === layer)
    && node.name.toLowerCase().includes(search.toLowerCase()));
  const columns = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  const width = Math.max(820, (columns + rows) * 125 + 180);
  const height = Math.max(430, (columns + rows) * 66 + 160);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = `${zoom * 100}%`;
  svg.style.minHeight = `${430 * zoom}px`;
  const positions = new Map(nodes.map((node, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    return [node.id, { x: width / 2 + (col - row) * 120 - (columns - rows) * 60,
      y: 95 + (col + row) * 66 }];
  }));
  const grid = svgElement('g', { class: 'grid', 'aria-hidden': 'true' });
  for (let i = 0; i < columns + rows + 3; i++) {
    grid.append(svgElement('path', { d: `M ${width / 2 - i * 120} 30 l ${width / 2} ${width / 4} M ${width / 2 + i * 120} 30 l ${-width / 2} ${width / 4}` }));
  }

  svg.append(grid);
  const edges = svgElement('g');
  for (const edge of graph.edges) {
    const start = positions.get(edge.source), end = positions.get(edge.target);
    if (!start || !end) continue;
    const active = selected === edge.source || selected === edge.target;
    const path = svgElement('path', {
      d: `M ${start.x} ${start.y + 28} L ${end.x} ${end.y + 28}`,
      class: `edge${active ? ' active' : ''}`,
      tabindex: '0', 'aria-label': `${edge.source} depends on ${edge.target}`,
    });
    path.append(svgElement('title', {}, `${edge.source} → ${edge.target}`));
    edges.append(path);
  }
  svg.append(edges);
  nodes.forEach((node, index) => {
    const { x, y } = positions.get(node.id);
    const state = health(node, view);
    const group = svgElement('g', {
      transform: `translate(${x},${y})`,
      class: `block ${state}${selected === node.id ? ' selected' : ''}${affected.includes(node.id) ? ' impacted' : ''}${node.vulnerabilityCount ? ' vulnerable' : ''}`,
      tabindex: '0', role: 'button', 'aria-pressed': String(selected === node.id),
      'aria-label': `${node.name}, ${node.kind}, ${state}, ${node.vulnerabilityCount} reported vulnerabilities`,
    });
    group.append(svgElement('title', {}, `${node.name} ${node.version}\n${state}`));
    group.append(svgElement('path', { class: 'block-left', d: 'M -52 0 L 0 27 L 0 62 L -52 35 Z' }));
    group.append(svgElement('path', { class: 'block-right', d: 'M 0 27 L 52 0 L 52 35 L 0 62 Z' }));
    group.append(svgElement('path', { class: 'block-top', d: 'M 0 -27 L 52 0 L 0 27 L -52 0 Z' }));
    group.append(svgElement('path', { class: 'light-strip', d: 'M -45 32 L 0 55 L 45 32' }));
    group.append(svgElement('text', { class: 'plate', y: 5, 'text-anchor': 'middle' }, String(index + 1).padStart(2, '0')));
    const label = node.name.length > 22 ? `${node.name.slice(0, 19)}…` : node.name;
    group.append(svgElement('text', { class: 'node-label', y: 85, 'text-anchor': 'middle' }, label));
    group.addEventListener('click', () => onSelect(node.id));
    group.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(node.id); }
    });
    svg.append(group);
  });
  if (!nodes.length) svg.append(svgElement('text', { x: width / 2, y: 190, 'text-anchor': 'middle', class: 'node-label' }, 'No matching components'));
}

export function createIsoGlowFigure(graph, { onSelect = () => {}, view = 'health' } = {}) {
  return {
    id: 'glow-dependencies',
    name: graph.project,
    hint: 'Click a component to inspect dependency impact',
    aria: `Dependency graph for ${graph.project}`,
    mount(stage) {
      renderGraph(stage, graph, {
        view, selected: undefined, affected: [], layer: 'all', search: '', zoom: 1, onSelect,
      });
      return { unmount() { stage.replaceChildren(); } };
    },
  };
}
