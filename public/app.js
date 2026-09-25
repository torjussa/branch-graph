import { api, h, icon, key, plural, s } from './lib.js';
import { openSettings } from './settings.js';

const LABEL_W = 190;
const LANE_H = 30;
const V_PAD = 14;
const PAD_L = 24;
const PAD_R = 40;
const AXIS_H = 28;
const ZOOM = { min: 8, max: 48, step: 1.25, initial: 18 };
const LIST_MAX = 10;
const FLAG_OPTIONS = [
  ['off', 'Off', 'No flow checks'],
  ['error', 'Errors', 'Squash or direct commits on promotion branches, and merges from the wrong branch'],
  ['all', 'Errors + warnings', 'Also merge commits, and commits without a PR, on the integration branch'],
];

const $ = (sel) => document.querySelector(sel);
const els = {
  project: $('#project'),
  fetched: $('#fetched'),
  refresh: $('#refresh'),
  settings: $('#settings'),
  flags: $('#flags'),
  zoomIn: $('#zoom-in'),
  zoomOut: $('#zoom-out'),
  repoToggles: $('#repo-toggles'),
  status: $('#status'),
  graph: $('#graph'),
  legend: $('#legend'),
  tooltip: $('#tooltip'),
};

let project = null;
let prefs = null;
let layout = null;
const data = {};
const dotIndex = new Map();

/* ---------- Formatting ---------- */

function rel(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 14) return `${Math.round(d / 86400)}d ago`;
  if (d < 86400 * 60) return `${Math.round(d / 604800)}w ago`;
  return `${Math.round(d / 2592000)}mo ago`;
}

// The viewer's preferred language (browser setting), not the OS locale.
const LOCALE = navigator.language || undefined;
const fmtDay = (d) => d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
const fmtDateTime = (sec) => new Date(sec * 1000).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const short = (sha) => sha.slice(0, 7);

/* ---------- State ---------- */

function prefsKey() { return `branch-graph:${project.name}`; }

function defaultPrefs() {
  return { zoom: ZOOM.initial, flags: 'off', hiddenRepos: [], hidden: {}, extras: {} };
}

/** Viewer preferences only. Anything else (e.g. the period) lives in the config. */
function loadPrefs() {
  const defaults = defaultPrefs();
  try {
    const stored = JSON.parse(localStorage.getItem(prefsKey()) || '{}');
    return { ...defaults, ...Object.fromEntries(Object.entries(stored).filter(([k]) => k in defaults)) };
  } catch {
    return defaults;
  }
}

/** Store only what differs from the defaults, so a changed default still reaches existing viewers. */
function savePrefs() {
  const defaults = defaultPrefs();
  const changed = Object.fromEntries(Object.entries(prefs).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])));
  try { localStorage.setItem(prefsKey(), JSON.stringify(changed)); } catch { /* storage unavailable */ }
}

const visibleRepos = () => project.repos.filter((r) => !prefs.hiddenRepos.includes(r.name));
const isHidden = (repo, branch) => (prefs.hidden[repo] || []).includes(branch);
const flagVisible = (flag) => flag && (prefs.flags === 'all' || (prefs.flags === 'error' && flag.level === 'error'));

/** Color follows the branch's stage in the config, so hiding a branch never repaints the others. */
function laneColor(repoName, branch) {
  const repo = project.repos.find((r) => r.name === repoName);
  const d = data[repoName];
  let i = repo.branches.indexOf(branch);
  if (i < 0) i = repo.branches.length + (d?.extras.indexOf(branch) ?? 0);
  return i < 8 ? `var(--lane-${i})` : 'var(--muted)';
}

/* ---------- Data ---------- */

async function loadRepo(name) {
  const params = new URLSearchParams({ name, days: project.days });
  const extras = prefs.extras[name] || [];
  if (extras.length) params.set('extra', extras.join(','));
  try {
    const d = await api(`/api/repo?${params}`);
    d.reachSet = {};
    for (const [a, byTarget] of Object.entries(d.reach)) {
      d.reachSet[a] = Object.fromEntries(Object.entries(byTarget).map(([b, list]) => [b, new Set(list)]));
    }
    data[name] = d;
  } catch (err) {
    data[name] = { error: err.message };
  }
}

async function loadAll() {
  document.body.classList.add('loading');
  await Promise.all(visibleRepos().map((r) => loadRepo(r.name)));
  document.body.classList.remove('loading');
  renderAll();
}

async function reloadRepo(name) {
  document.body.classList.add('loading');
  await loadRepo(name);
  document.body.classList.remove('loading');
  renderAll();
}

/** Reload everything after the config was saved in settings. */
async function reloadProject() {
  project = await api('/api/project');
  prefs = loadPrefs();
  for (const name of Object.keys(data)) delete data[name];
  renderControls();
  await loadAll();
}

async function fetchRemotes() {
  els.refresh.disabled = true;
  els.refresh.textContent = 'Fetching…';
  try {
    const result = await api('/api/fetch', { method: 'POST' });
    project = { ...(await api('/api/project')), fetchedAt: result.fetchedAt, fetchErrors: result.fetchErrors };
    renderFetched();
    await loadAll();
  } catch (err) {
    els.fetched.replaceChildren(h('span', { class: 'fetch-error' }, `Fetch failed: ${err.message}`));
  } finally {
    els.refresh.disabled = false;
    els.refresh.textContent = 'Fetch';
  }
}

/* ---------- Controls ---------- */

function renderControls() {
  document.title = `${project.name} · Branch graph`;
  els.project.textContent = project.name;

  els.flags.replaceChildren(...FLAG_OPTIONS.map(([value, label, title]) => segment('flags', value, label, value === prefs.flags, title)));
  els.flags.closest('.group').hidden = !project.flow;
  renderRepoToggles();
  renderFetched();
  renderLegend();
}

function segment(name, value, label, checked, title) {
  return h('label', { title }, h('input', { type: 'radio', name, value, checked }), h('span', {}, label));
}

function renderRepoToggles() {
  els.repoToggles.replaceChildren(...project.repos.map((r) => {
    const on = !prefs.hiddenRepos.includes(r.name);
    return h('button', {
      type: 'button',
      class: 'toggle',
      'aria-pressed': String(on),
      title: on ? `Hide ${r.name}` : `Show ${r.name}`,
      onclick: async () => {
        prefs.hiddenRepos = on ? [...prefs.hiddenRepos, r.name] : prefs.hiddenRepos.filter((n) => n !== r.name);
        savePrefs();
        renderRepoToggles();
        if (!on && !data[r.name]) await reloadRepo(r.name);
        else renderAll();
      },
    }, icon('check'), r.name);
  }));
}

function renderFetched() {
  const parts = [];
  parts.push(project.fetchedAt ? `Fetched ${rel(project.fetchedAt / 1000)}` : 'Not fetched this session');
  const errors = Object.keys(project.fetchErrors || {});
  const node = h('span', {}, parts);
  if (errors.length) {
    node.append(' · ', h('span', { class: 'fetch-error', title: Object.values(project.fetchErrors).join('\n') }, `fetch failed: ${errors.join(', ')}`));
  }
  els.fetched.replaceChildren(node);
}

function renderLegend() {
  const sample = (...children) => s('svg', { width: 26, height: 16, 'aria-hidden': 'true' }, ...children);
  const c = 'var(--lane-0)';
  const c2 = 'var(--lane-1)';
  els.legend.replaceChildren(...[
    h('span', {}, sample(s('circle', { cx: 13, cy: 8, r: 4.5, fill: c })), 'In next branch'),
    h('span', {}, sample(s('circle', { cx: 13, cy: 8, r: 4.5, fill: 'var(--surface)', stroke: c, 'stroke-width': 2 })), 'Not yet in next branch'),
    h('span', {}, sample(s('circle', { cx: 13, cy: 8, r: 6, fill: c })), 'Merge commit'),
    h('span', {}, sample(s('path', { d: 'M2 3 C12 3 14 13 24 13', stroke: c, 'stroke-width': 1.75, fill: 'none' })), 'Merge from another lane'),
    h('span', {}, sample(s('path', { d: 'M6 2 Q14 2 18 12', class: 'stub' }), s('circle', { cx: 18, cy: 12, r: 3, fill: c })), 'Merged from a branch not shown'),
    h('span', {}, sample(s('line', { x1: 13, x2: 13, y1: 1, y2: 15, stroke: c2, 'stroke-width': 1.5, 'stroke-dasharray': '3 3' })), 'Branch points at a commit on another lane'),
    prefs.flags !== 'off'
      ? h('span', {}, sample(s('circle', { cx: 13, cy: 8, r: 6.5, fill: 'none', stroke: 'var(--error)', 'stroke-width': 2 }), s('circle', { cx: 13, cy: 8, r: 3, fill: c })), 'Flow error')
      : null,
    prefs.flags === 'all'
      ? h('span', {}, sample(s('circle', { cx: 13, cy: 8, r: 6.5, fill: 'none', stroke: 'var(--warn)', 'stroke-width': 2 }), s('circle', { cx: 13, cy: 8, r: 3, fill: c })), 'Flow warning')
      : null,
  ].filter(Boolean));
}

/* ---------- Status cards ---------- */

function renderStatus() {
  els.status.replaceChildren(...visibleRepos().map(statusCard));
}

function statusCard(repo) {
  const d = data[repo.name];
  const head = h('div', { class: 'card-head' }, h('h2', {}, repo.name),
    repo.webUrl ? h('a', { href: repo.webUrl, target: '_blank', rel: 'noopener' }, 'GitHub ↗') : null);
  if (!d) return h('article', { class: 'card' }, head, h('p', { class: 'muted' }, 'Loading…'));
  if (d.error) return h('article', { class: 'card' }, head, h('div', { class: 'state error' }, icon('alert'), d.error));

  const pairs = d.status.length
    ? h('ul', { class: 'pairs' }, d.status.map((st) => pairRow(repo, d, st)))
    : h('p', { class: 'muted' }, 'Only one branch configured.');

  const missing = d.missing.length
    ? h('div', { class: 'state error' }, icon('alert'), `Not on remote: ${d.missing.join(', ')}`)
    : null;

  return h('article', { class: 'card' }, head, missing, pairs, flagSummary(repo, d));
}

function pairRow(repo, d, st) {
  const { ahead, behind, diff } = st;
  let state;
  if (!diff) {
    state = h('span', { class: 'state good' }, icon('check'), ahead.n || behind.n ? 'Same code' : 'In sync');
  } else if (!ahead.n) {
    // Only the downstream branch has changes (e.g. a hotfix); the note below says which.
    state = h('span', { class: 'state' }, h('strong', {}, 'Nothing to promote'), h('span', { class: 'muted' }, ` · ${plural(diff.files, 'file')} ${diff.files === 1 ? 'differs' : 'differ'}`));
  } else {
    state = h('span', { class: 'state' },
      h('strong', {}, `${ahead.n}${ahead.capped ? '+' : ''} ${ahead.n === 1 ? 'commit' : 'commits'}`),
      h('span', { class: 'muted' }, ` · ${plural(diff.files, 'file')} `),
      h('span', { class: 'ins' }, `+${diff.ins}`), ' ', h('span', { class: 'del' }, `−${diff.del}`));
  }

  const notes = [];
  if (behind.n) {
    notes.push(h('span', { class: 'state error' }, icon('alert'), `${plural(behind.n, 'commit')} on ${st.to} not in ${st.from}`));
  }
  if (st.fastForward && project.flow?.promotion === 'merge') {
    notes.push(h('span', { class: 'state warn' }, icon('alert'), `${st.to} fast-forwarded onto ${st.from} (no merge commit)`));
  }

  const compare = d.webUrl
    ? h('a', { href: `${d.webUrl}/compare/${encodeURIComponent(st.to)}...${encodeURIComponent(st.from)}`, target: '_blank', rel: 'noopener' }, 'Compare ↗')
    : h('span');

  const row = h('li', { class: 'pair', tabindex: 0 },
    h('span', { class: 'pair-name' }, key(laneColor(repo.name, st.from)), st.from, h('span', { class: 'arrow' }, '→'), key(laneColor(repo.name, st.to)), st.to),
    compare,
    h('span', {}, state),
    h('span'),
    notes.length ? h('div', { class: 'notes' }, notes) : null);

  const show = (e) => {
    highlight(repo.name, [...ahead.list, ...behind.list].map((c) => c.h));
    showTooltip(pairTooltip(st), e);
  };
  row.addEventListener('pointerenter', show);
  row.addEventListener('pointermove', (e) => placeTooltip(e.clientX, e.clientY));
  row.addEventListener('pointerleave', hideTooltip);
  row.addEventListener('focus', show);
  row.addEventListener('blur', hideTooltip);
  return row;
}

function flagSummary(repo, d) {
  if (prefs.flags === 'off' || !project.flow) return null;
  const flagged = Object.values(d.commits).filter((c) => flagVisible(c.flag));
  const errors = flagged.filter((c) => c.flag.level === 'error');
  const warns = flagged.filter((c) => c.flag.level === 'warn');
  if (!flagged.length) {
    return h('div', { class: 'card-foot' }, h('span', { class: 'state good' }, icon('check'), `No flow issues in the last ${project.days} days`));
  }
  const item = (list, level, word) => {
    if (!list.length) return null;
    const node = h('span', { class: `state ${level}`, tabindex: 0 }, icon('alert'), `${plural(list.length, word)}`);
    const show = (e) => {
      highlight(repo.name, list.map((c) => c.sha));
      showTooltip([
        h('div', { class: 'tt-head' }, `${plural(list.length, word)} in the last ${project.days} days`),
        commitList(list.map((c) => ({ h: c.sha, s: `${c.s} — ${c.flag.msg}` }))),
      ], e);
    };
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', (e) => placeTooltip(e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTooltip);
    node.addEventListener('focus', show);
    node.addEventListener('blur', hideTooltip);
    return node;
  };
  return h('div', { class: 'card-foot' }, item(errors, 'error', 'flow error'), item(warns, 'warn', 'flow warning'));
}

function commitList(list, total = list.length) {
  return h('ul', { class: 'tt-list' },
    list.slice(0, LIST_MAX).map((c) => h('li', {}, h('code', {}, short(c.h)), c.s, c.an ? h('span', { class: 'muted' }, ` · ${c.an}`) : null)),
    total > LIST_MAX ? h('li', { class: 'muted' }, `+${total - LIST_MAX} more`) : null);
}

function pairTooltip(st) {
  const parts = [h('div', { class: 'tt-title' }, `${st.from} → ${st.to}`)];
  if (st.ahead.n) {
    parts.push(h('div', { class: 'tt-head' }, `${plural(st.ahead.n, 'commit')} in ${st.from}, not in ${st.to}`), commitList(st.ahead.list, st.ahead.n));
  } else {
    parts.push(h('div', { class: 'muted' }, `Nothing in ${st.from} that ${st.to} lacks.`));
  }
  if (st.behind.n) {
    parts.push(h('div', { class: 'tt-head' }, `${plural(st.behind.n, 'commit')} on ${st.to}, not in ${st.from}`), commitList(st.behind.list, st.behind.n));
  }
  if (st.diff) parts.push(h('div', { class: 'tt-meta' }, `Code diff: ${plural(st.diff.files, 'file')}, +${st.diff.ins} −${st.diff.del}`));
  return parts;
}

/* ---------- Graph layout ---------- */

/**
 * Lanes: one per visible branch, pipeline first. A commit sits on the first lane whose
 * first-parent chain holds it. Columns: every visible commit across all repos, ordered by
 * commit time, so a vertical line is the same moment in every repo.
 */
function buildLayout() {
  const blocks = [];
  visibleRepos().forEach((repo, ri) => {
    const d = data[repo.name];
    if (!d || d.error) return;
    const lanes = [...d.pipeline, ...d.extras].filter((b) => !isHidden(repo.name, b));
    const laneOf = new Map();
    const depth = new Map();
    lanes.forEach((b, li) => d.branches[b].chain.forEach((sha, k) => {
      if (!laneOf.has(sha)) { laneOf.set(sha, li); depth.set(sha, k); }
    }));
    blocks.push({ repo, d, ri, lanes, laneOf, depth, x: new Map() });
  });

  const cols = [];
  for (const b of blocks) for (const [sha, li] of b.laneOf) cols.push({ b, sha, li, cd: b.d.commits[sha].cd, k: b.depth.get(sha) });
  cols.sort((p, q) => p.cd - q.cd || p.b.ri - q.b.ri || p.li - q.li || q.k - p.k);

  const col = prefs.zoom;
  cols.forEach((c, i) => c.b.x.set(c.sha, PAD_L + i * col + col / 2));
  const width = PAD_L + cols.length * col + PAD_R;

  // Day boundaries, with week starts marked.
  const bounds = [];
  let prevDay = null;
  let prevWeek = null;
  cols.forEach((c, i) => {
    const date = new Date(c.cd * 1000);
    const day = date.toDateString();
    if (day === prevDay) return;
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const week = monday.toDateString();
    bounds.push({ x: PAD_L + i * col, date, week: prevWeek !== null && week !== prevWeek });
    prevDay = day;
    prevWeek = week;
  });

  return { blocks, width, col, bounds };
}

const laneY = (li) => V_PAD + li * LANE_H + LANE_H / 2;

function edge(x1, y1, x2, y2, color, cls = '') {
  if (y1 === y2) {
    if (cls === 'merge') {
      return s('path', { d: `M${x1},${y1} C${x1},${y1 - 16} ${x2},${y2 - 16} ${x2},${y2}`, stroke: color, class: `edge ${cls}` });
    }
    return s('line', { x1, y1, x2, y2, stroke: color, class: `edge ${cls}` });
  }
  const k = Math.min((x2 - x1) / 2, Math.max(layout.col * 1.2, 14));
  return s('path', { d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`, stroke: color, class: `edge ${cls}` });
}

function renderBlock(b) {
  const { width, bounds, col } = layout;
  const height = V_PAD * 2 + b.lanes.length * LANE_H;
  const X = (sha) => b.x.get(sha);
  const color = (li) => laneColor(b.repo.name, b.lanes[li]);

  const grid = s('g', { class: 'grid' }, bounds.map((bd) => s('line', { x1: bd.x, x2: bd.x, y1: 0, y2: height, class: bd.week ? 'week' : null })));
  const edges = s('g', { class: 'edges' });
  const pointers = s('g', { class: 'pointers' });
  const dots = s('g', { class: 'dots' });

  // First-parent lines. An edge belongs to the lane that owns the child commit.
  b.lanes.forEach((branch, li) => {
    const { chain, truncated, tip } = b.d.branches[branch];
    chain.forEach((child, k) => {
      if (b.laneOf.get(child) !== li) return;
      const parent = chain[k + 1];
      if (parent !== undefined) edges.append(edge(X(parent), laneY(b.laneOf.get(parent)), X(child), laneY(li), color(li)));
      else if (truncated) edges.append(s('line', { x1: 0, x2: X(child), y1: laneY(li), y2: laneY(li), stroke: color(li), class: 'edge fade' }));
    });

    // Branch head: dotted line from the tip to the right edge ("the branch is here now").
    if (!tip || !b.laneOf.has(tip)) return;
    const tipLane = b.laneOf.get(tip);
    const tx = X(tip);
    edges.append(s('line', { x1: tx, x2: width - 8, y1: laneY(li), y2: laneY(li), stroke: color(li), class: 'edge head' }));
    if (tipLane !== li) {
      pointers.append(
        s('line', { x1: tx, x2: tx, y1: laneY(li), y2: laneY(tipLane), stroke: color(li), class: 'edge pointer' }),
        s('circle', { cx: tx, cy: laneY(li), r: 3.5, stroke: color(li), class: 'pointer-ring' }),
      );
    }
  });

  // Second-parent (merge) lines.
  for (const [sha, li] of b.laneOf) {
    const c = b.d.commits[sha];
    if (c.p.length < 2) continue;
    const p2 = c.p[1];
    if (b.laneOf.has(p2)) {
      const pl = b.laneOf.get(p2);
      edges.append(edge(X(p2), laneY(pl), X(sha), laneY(li), color(pl), 'merge'));
    } else {
      const x = X(sha);
      const y = laneY(li);
      edges.append(s('path', { d: `M${x - 12},${y - 10} Q${x - 3},${y - 10} ${x},${y}`, class: 'stub' }));
    }
  }

  // Commits.
  const hitR = Math.min(12, Math.max(6, col * 0.6));
  for (const [sha, li] of b.laneOf) {
    const c = b.d.commits[sha];
    const branch = b.lanes[li];
    const pi = b.d.pipeline.indexOf(branch);
    const next = pi >= 0 ? b.d.pipeline[pi + 1] : null;
    const pending = next ? b.d.reachSet[branch][next].has(sha) : false;
    const merge = c.p.length > 1;
    const r = merge ? 5.5 : 4.5;
    const cx = X(sha);
    const cy = laneY(li);
    const g = s('g', {
      class: `c${pending ? ' pending' : ''}`,
      style: `--c: ${color(li)}`,
      'data-repo': b.repo.name,
      'data-sha': sha,
      tabindex: 0,
      role: 'button',
      'aria-label': `${branch}: ${c.s} (${short(sha)})`,
    });
    if (flagVisible(c.flag)) g.append(s('circle', { cx, cy, r: r + 4, class: `flag ${c.flag.level}` }));
    g.append(s('circle', { cx, cy, r, class: 'dot' }), s('circle', { cx, cy, r: hitR, class: 'hit' }));
    dots.append(g);
    dotIndex.set(`${b.repo.name}\0${sha}`, g);
  }

  return s('svg', { width, height, class: 'lanes' }, grid, edges, pointers, dots);
}

function renderAxis() {
  const { width, bounds } = layout;
  const svg = s('svg', { width, height: AXIS_H, class: 'axis' });
  let lastX = -Infinity;
  for (const bd of bounds) {
    svg.append(s('line', { x1: bd.x, x2: bd.x, y1: AXIS_H - 6, y2: AXIS_H, class: 'tick' }));
    if (bd.x - lastX < 48) continue;
    svg.append(s('text', { x: bd.x + 4, y: AXIS_H - 10, class: bd.week ? 'week' : null }, fmtDay(bd.date)));
    lastX = bd.x;
  }
  svg.append(s('line', { x1: 0, x2: width, y1: AXIS_H - 0.5, y2: AXIS_H - 0.5, class: 'base' }));
  return svg;
}

function repoHead(repo) {
  const d = data[repo.name];
  const inner = h('div', { class: 'sticky head-inner' }, h('h2', {}, repo.name));
  if (!d) return inner.append(h('span', { class: 'muted' }, 'Loading…')), inner;
  if (d.error) return inner.append(h('span', { class: 'state error' }, icon('alert'), d.error)), inner;

  for (const branch of [...d.pipeline, ...d.extras]) {
    const extra = d.extras.includes(branch);
    const hidden = isHidden(repo.name, branch);
    inner.append(h('span', { class: `chip${hidden ? ' off' : ''}${extra ? ' extra' : ''}` },
      h('button', {
        type: 'button',
        class: 'chip-btn',
        'aria-pressed': String(!hidden),
        title: hidden ? `Show ${branch}` : `Hide ${branch}`,
        onclick: () => toggleBranch(repo.name, branch),
      }, key(laneColor(repo.name, branch)), branch),
      extra ? h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${branch}`, title: `Remove ${branch}`, onclick: () => removeExtra(repo.name, branch) }, '×') : null));
  }

  const addable = d.available.filter((b) => !d.pipeline.includes(b) && !d.extras.includes(b));
  if (addable.length) {
    inner.append(h('select', {
      class: 'add',
      'aria-label': `Add a branch to ${repo.name}`,
      onchange: (e) => addExtra(repo.name, e.target.value),
    }, h('option', { value: '' }, '+ branch'), addable.map((b) => h('option', { value: b }, b))));
  }
  return inner;
}

function laneLabels(b) {
  const box = h('div', { class: 'sticky lane-labels', style: { width: `${LABEL_W}px`, padding: `${V_PAD}px 0` } });
  for (const branch of b.lanes) {
    const tip = b.d.commits[b.d.branches[branch].tip];
    box.append(h('div', { class: 'lane-label', style: { height: `${LANE_H}px` }, title: branch },
      key(laneColor(b.repo.name, branch)),
      h('span', { class: 'lane-name' }, branch),
      tip ? h('span', { class: 'muted age' }, rel(tip.cd)) : null));
  }
  return box;
}

function renderGraph({ keepCenter = false } = {}) {
  const sc = els.graph;
  const hadContent = sc.scrollWidth > sc.clientWidth;
  const atEnd = !hadContent || sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 8;
  const center = hadContent ? (sc.scrollLeft + sc.clientWidth / 2 - LABEL_W) / (sc.scrollWidth - LABEL_W) : 1;

  dotIndex.clear();
  layout = buildLayout();
  const repos = visibleRepos();
  if (!repos.length) {
    sc.replaceChildren(h('p', { class: 'empty muted' }, 'No repos selected.'));
    return;
  }

  const canvas = h('div', { class: 'canvas', style: { width: `${LABEL_W + layout.width}px` } },
    h('div', { class: 'row' }, h('div', { class: 'sticky corner', style: { width: `${LABEL_W}px` } }), renderAxis()));

  for (const repo of repos) {
    canvas.append(h('div', { class: 'repo-head' }, repoHead(repo)));
    const b = layout.blocks.find((x) => x.repo.name === repo.name);
    if (!b) continue;
    if (!b.lanes.length) {
      canvas.append(h('div', { class: 'row' }, h('div', { class: 'sticky lane-note' }, 'All branches hidden.')));
      continue;
    }
    canvas.append(h('div', { class: 'row' }, laneLabels(b), renderBlock(b)));
  }
  sc.replaceChildren(canvas);

  if (keepCenter && !atEnd) sc.scrollLeft = LABEL_W + center * (sc.scrollWidth - LABEL_W) - sc.clientWidth / 2;
  else if (atEnd) sc.scrollLeft = sc.scrollWidth;
}

function renderAll(opts) {
  hideTooltip();
  renderStatus();
  renderGraph(opts);
}

/* ---------- Branch selection ---------- */

function toggleBranch(repo, branch) {
  const list = prefs.hidden[repo] || [];
  prefs.hidden[repo] = list.includes(branch) ? list.filter((b) => b !== branch) : [...list, branch];
  savePrefs();
  renderAll({ keepCenter: true });
}

async function addExtra(repo, branch) {
  if (!branch) return;
  prefs.extras[repo] = [...new Set([...(prefs.extras[repo] || []), branch])];
  savePrefs();
  await reloadRepo(repo);
}

async function removeExtra(repo, branch) {
  prefs.extras[repo] = (prefs.extras[repo] || []).filter((b) => b !== branch);
  prefs.hidden[repo] = (prefs.hidden[repo] || []).filter((b) => b !== branch);
  savePrefs();
  await reloadRepo(repo);
}

/* ---------- Tooltip & highlight ---------- */

let highlighted = [];

function highlight(repo, shas) {
  clearHighlight();
  for (const sha of shas) {
    const g = dotIndex.get(`${repo}\0${sha}`);
    if (g) { g.classList.add('hl'); highlighted.push(g); }
  }
  if (highlighted.length > 1) els.graph.classList.add('focusing');
}

function clearHighlight() {
  for (const g of highlighted) g.classList.remove('hl');
  highlighted = [];
  els.graph.classList.remove('focusing');
}

function showTooltip(children, e) {
  els.tooltip.replaceChildren(...children.filter(Boolean));
  els.tooltip.hidden = false;
  if (e?.clientX !== undefined && e.type.startsWith('pointer')) {
    placeTooltip(e.clientX, e.clientY);
  } else {
    const r = e.target.getBoundingClientRect();
    placeTooltip(r.right, r.bottom);
  }
}

function placeTooltip(x, y) {
  const t = els.tooltip;
  if (t.hidden) return;
  const gap = 14;
  const { width, height } = t.getBoundingClientRect();
  let left = x + gap;
  let top = y + gap;
  if (left + width > window.innerWidth - 8) left = Math.max(8, x - gap - width);
  if (top + height > window.innerHeight - 8) top = Math.max(8, y - gap - height);
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
  clearHighlight();
}

function commitTooltip(repoName, sha) {
  const d = data[repoName];
  const b = layout.blocks.find((x) => x.repo.name === repoName);
  const c = d.commits[sha];
  const branch = b.lanes[b.laneOf.get(sha)];
  const parts = [];

  if (flagVisible(c.flag)) parts.push(h('div', { class: `tt-flag ${c.flag.level}` }, icon('alert'), c.flag.msg));
  parts.push(h('div', { class: 'tt-title' }, c.s));
  const lines = c.b.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length) {
    parts.push(h('div', { class: 'tt-body' }, lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '')));
  }
  parts.push(h('div', { class: 'tt-meta' }, h('code', {}, short(sha)), ` · ${c.an} · ${fmtDateTime(c.cd)} (${rel(c.cd)})`));

  const role = c.role ?? (c.p.length > 1 ? `Merge from ${c.from ?? 'another branch'}` : null);
  if (role || c.inc) {
    const count = c.inc ? ` · brought in ${c.inc.n}${c.inc.capped ? '+' : ''} ${c.inc.n === 1 ? 'commit' : 'commits'}` : '';
    parts.push(h('div', { class: 'tt-role' }, icon('arrow'), `${role ?? 'Merge'}${count}`));
  }
  if (c.inc?.list.length) parts.push(commitList(c.inc.list, c.inc.n));

  const pi = d.pipeline.indexOf(branch);
  if (pi >= 0 && pi < d.pipeline.length - 1) {
    parts.push(h('div', { class: 'tt-reach' }, d.pipeline.slice(pi + 1).map((to) => {
      const inIt = !d.reachSet[branch][to].has(sha);
      return h('span', { class: `state ${inIt ? 'good' : ''}` }, icon(inIt ? 'check' : 'clock'), `${inIt ? 'In' : 'Not in'} ${to}`);
    })));
  }

  const tipOf = Object.entries(d.branches).filter(([, br]) => br.tip === sha).map(([name]) => name);
  if (tipOf.length) parts.push(h('div', { class: 'tt-meta' }, `Tip of ${tipOf.join(', ')}`));
  if (d.webUrl) parts.push(h('div', { class: 'tt-hint' }, 'Click to open on GitHub'));
  return parts;
}

function commitUrl(repoName, sha) {
  const web = data[repoName]?.webUrl;
  return web ? `${web}/commit/${sha}` : null;
}

function onCommitEnter(e) {
  const g = e.target.closest?.('g.c');
  if (!g) return;
  const { repo, sha } = g.dataset;
  const c = data[repo].commits[sha];
  highlight(repo, [sha, ...(c.inc?.all ?? [])]);
  showTooltip(commitTooltip(repo, sha), e);
}

function onCommitLeave(e) {
  const g = e.target.closest?.('g.c');
  if (g && !g.contains(e.relatedTarget)) hideTooltip();
}

function openCommit(g) {
  const url = commitUrl(g.dataset.repo, g.dataset.sha);
  if (url) window.open(url, '_blank', 'noopener');
}

/* ---------- Wiring ---------- */

els.graph.addEventListener('pointerover', onCommitEnter);
els.graph.addEventListener('pointerout', onCommitLeave);
els.graph.addEventListener('pointermove', (e) => placeTooltip(e.clientX, e.clientY));
els.graph.addEventListener('focusin', onCommitEnter);
els.graph.addEventListener('focusout', onCommitLeave);
els.graph.addEventListener('click', (e) => {
  const g = e.target.closest?.('g.c');
  if (g) openCommit(g);
});
els.graph.addEventListener('keydown', (e) => {
  const g = e.target.closest?.('g.c');
  if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCommit(g); }
});
els.graph.addEventListener('scroll', hideTooltip, { passive: true });

els.refresh.addEventListener('click', fetchRemotes);
els.settings.addEventListener('click', () => openSettings({ project, onSaved: reloadProject }));
els.flags.addEventListener('change', (e) => {
  prefs.flags = e.target.value;
  savePrefs();
  renderLegend();
  renderAll({ keepCenter: true });
});
const zoom = (factor) => {
  prefs.zoom = Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, prefs.zoom * factor)));
  savePrefs();
  renderGraph({ keepCenter: true });
};
els.zoomIn.addEventListener('click', () => zoom(ZOOM.step));
els.zoomOut.addEventListener('click', () => zoom(1 / ZOOM.step));

setInterval(() => project && renderFetched(), 30_000);

try {
  project = await api('/api/project');
  prefs = loadPrefs();
  renderControls();
  await loadAll();
} catch (err) {
  els.status.replaceChildren(h('article', { class: 'card' }, h('div', { class: 'state error' }, icon('alert'), `Could not load: ${err.message}`)));
}
