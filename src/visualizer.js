import './styles.css';
import { parseInput, health, affectedBy, MAX_INPUT_BYTES } from './parser.js';
import { refreshGraph } from './data-fetcher.js';
import { renderGraph } from './iso-glow-adapter.js';

const $ = id => document.getElementById(id);
let base, graph, selected, view = 'health', zoom = 1, timer, controller, generation = 0;
const message = text => { $('message').textContent = text; };
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function details() {
  const panel = $('details');
  panel.replaceChildren();
  const node = graph.nodes.find(item => item.id === selected);
  if (!node) {
    panel.append(element('p', 'COMPONENT INSPECTOR', 'eyebrow'), element('h2', 'Follow the connections.'),
      element('p', 'Select any block to inspect its version, security findings, and downstream impact.'));
    return;
  }
  const impacted = affectedBy(graph, node.id);
  panel.append(element('p', `${node.kind.toUpperCase()} / ${node.ecosystem}`, 'eyebrow'),
    element('h2', node.name), element('p', node.description || 'No description provided.'));
  const rows = [
    ['Version', node.version || 'Not specified'], ['Health', health(node)],
    ['License', node.license], ['Security scan', node.scan],
    [node.ecosystem === 'NuGet' ? 'Latest stable NuGet version' : 'Latest registry version', node.latest || 'Not checked'],
    ['Version differs from latest', node.updateAvailable ? 'Yes — review compatibility' : 'Not established'],
    ['Deprecated', node.deprecated ? 'Yes (configured or latest release)' : 'Not reported'],
    ['GitHub status', node.githubStatus || 'Not checked'],
    ['Last security check', node.checkedAt || 'Never'],
  ];
  const dl = element('dl');
  for (const [key, value] of rows) dl.append(element('dt', key), element('dd', value));
  panel.append(dl, element('h3', `Reported vulnerabilities (${node.vulnerabilityCount})`));
  if (node.ecosystem === 'NuGet') panel.append(element('p',
    'NuGet OSV matching is case-sensitive. Queries use the imported package spelling; empty results have limited coverage and do not clear security status.'));
  if (!node.advisories.length) panel.append(element('p', node.vulnerabilityCount
    ? 'Configuration supplies a count only. Check your security source for advisory details.'
    : 'No findings reported. Unchecked or unresolved packages are not security-cleared.'));
  for (const advisory of node.advisories) {
    const box = element('div', undefined, 'advisory');
    box.append(element('strong', `${advisory.id} · ${advisory.severity}`), element('p', advisory.summary));
    if (/^(GHSA-[\w-]+|CVE-\d{4}-\d+|PYSEC-[\w-]+)$/.test(advisory.id)) {
      const link = element('a', 'Open advisory ↗');
      link.href = `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.append(link);
    }
    panel.append(box);
  }
  panel.append(element('h3', 'Update / incident blast radius'),
    element('p', impacted.length ? `${impacted.length} component(s) depend on this node, directly or transitively.` : 'No known dependents in this configuration.'));
  for (const id of impacted) {
    const button = element('button', id, 'impact-link');
    button.onclick = () => select(id);
    panel.append(button);
  }
  panel.append(element('h3', 'Direct dependencies'),
    element('p', node.dependencies.join(', ') || 'None declared'));
  for (const error of node.errors) panel.append(element('p', error, 'error'));
}

function draw() {
  if (!graph) return;
  const focus = document.activeElement?.getAttribute('aria-label');
  $('project').textContent = graph.project;
  $('count').textContent = graph.nodes.length;
  for (const status of ['healthy', 'warning', 'critical']) {
    $(status).textContent = graph.nodes.filter(node => health(node) === status).length;
  }
  $('findings').textContent = graph.nodes.reduce((sum, node) => sum + node.vulnerabilityCount, 0);
  renderGraph($('graph'), graph, { view, selected, zoom,
    affected: selected ? affectedBy(graph, selected) : [],
    layer: $('layer').value, search: $('search').value, onSelect: select });
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  details();
  if (focus) [...$('graph').querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focus)?.focus();
}

function select(id) { selected = id; draw(); }
function stop() {
  generation++;
  controller?.abort();
  clearTimeout(timer);
  $('refresh').disabled = false;
}
function load(source, filename) {
  const parsed = parseInput(source, filename);
  stop();
  $('live').checked = false;
  base = parsed;
  graph = structuredClone(base);
  selected = undefined;
  $('updated').textContent = 'Local configuration · not a live security assessment';
  message(`Loaded ${graph.project}. Live network access is off.`);
  draw();
}

async function scenario() {
  stop();
  const current = generation;
  try {
    const name = $('scenario').value;
    const response = await fetch(`./examples/${name}`);
    if (!response.ok) throw new Error(`Example could not load (HTTP ${response.status}).`);
    const source = await response.text();
    if (current !== generation) return;
    load(source, name);
    $('config').value = source;
    $('format').value = 'glow.config.yaml';
    message('Illustrative demo data — including vulnerability counts — is not a live audit.');
  } catch (error) { if (current === generation) message(error.message); }
}

async function refresh() {
  if (!base || $('refresh').disabled) return;
  clearTimeout(timer);
  controller = new AbortController();
  const current = generation;
  $('refresh').disabled = true;
  message('Checking npm, NuGet, OSV, and configured GitHub repositories…');
  try {
    const result = await refreshGraph(base, { signal: controller.signal });
    if (current !== generation) return;
    graph = result;
    const errors = graph.nodes.reduce((sum, node) => sum + node.errors.length, 0);
    const unchecked = graph.nodes.filter(node => node.kind === 'package' && !['clean', 'findings'].includes(node.scan)).length;
    $('updated').textContent = `Last refresh: ${new Date(graph.refreshedAt).toLocaleTimeString()} · ${errors} API errors · ${unchecked} packages with unresolved or limited scans`;
    message('Refresh complete. Inspect each component for findings, unverified versions, and API errors.');
    draw();
  } catch (error) { if (current === generation) message(`Refresh failed: ${error.message}`); }
  finally {
    if (current === generation) {
      $('refresh').disabled = false;
      if ($('live').checked) timer = setTimeout(refresh, 60000);
    }
  }
}

$('scenario').onchange = scenario;
$('file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > MAX_INPUT_BYTES) throw new Error('Maximum file size is 1 MB.');
    load(await file.text(), file.name);
  } catch (error) { message(`Import failed: ${error.message}`); }
  event.target.value = '';
};
$('edit').onclick = () => { $('editor-error').textContent = ''; $('editor').showModal(); };
$('cancel').onclick = () => $('editor').close();
$('config-form').onsubmit = event => {
  event.preventDefault();
  try { load($('config').value, $('format').value); $('editor').close(); }
  catch (error) { $('editor-error').textContent = error.message; }
};
for (const button of document.querySelectorAll('[data-view]')) {
  button.onclick = () => { view = button.dataset.view; draw(); };
}
$('audience').onchange = () => {
  view = { developer: 'dependency', devops: 'health', architect: 'dependency', security: 'security' }[$('audience').value];
  draw();
};
$('layer').onchange = draw;
$('search').oninput = draw;
$('zoom-in').onclick = () => { zoom = Math.min(3, zoom + 0.25); draw(); };
$('zoom-out').onclick = () => { zoom = Math.max(0.5, zoom - 0.25); draw(); };
$('reset').onclick = () => { zoom = 1; selected = undefined; $('search').value = ''; $('layer').value = 'all'; draw(); };
$('refresh').onclick = refresh;
$('live').onchange = () => { if ($('live').checked) refresh(); else stop(); };
$('export').onclick = () => {
  if (!graph) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }));
  const link = element('a');
  link.href = url; link.download = 'glow-report.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', stop);
scenario();
