import { api, h, icon } from './lib.js';
import { remoteLabel } from './remote.js';

const PERIODS = [14, 30, 60, 90, 180, 365];
const INTEGRATION = [['squash', 'Squash merges'], ['merge', 'Merge commits'], ['any', 'Anything']];
const PROMOTION = [['merge', 'Merge commits'], ['squash', 'Squash merges'], ['any', 'Anything']];
const DEFAULT_FLOW = { integration: 'squash', promotion: 'merge' };
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const THEME_KEY = 'branch-graph:theme'; // theme.js reads it before the page paints

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sourceOf = (repo) => repo.url ?? repo.path;
const sourceLabel = (repo) => (repo.url ? remoteLabel(repo.url) : repo.path);
const sameSource = (a, b) => sourceOf(a).toLowerCase() === sourceOf(b).toLowerCase();

function select(options, value, props = {}) {
  return h('select', props, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

const currentTheme = () => document.documentElement.dataset.theme ?? 'system';

/** A viewer preference, not part of the config: it applies and is stored in this browser right away. */
function setTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch { /* storage unavailable */ }
}

/**
 * Settings dialog: edits the config file the server runs with.
 * Changes stay in a draft until Save; the server validates, writes the file and reloads.
 */
export async function openSettings({ project, onSaved }) {
  document.querySelector('dialog.modal')?.remove();
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'settings-title' });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.append(h('div', { class: 'modal-content' }, h('p', { class: 'muted' }, 'Loading…')));
  dialog.showModal();

  let loaded;
  try {
    loaded = await api('/api/config');
  } catch (err) {
    dialog.replaceChildren(h('div', { class: 'modal-content' }, h('div', { class: 'state error' }, icon('alert'), `Could not load the config: ${err.message}`)));
    return;
  }

  const draft = structuredClone(loaded.config);
  // Branches on each repo's remote, for the "+ branch" pickers. Existing repos: from the server's refs.
  const available = new Map(draft.repos.map((r) => [r, project.repos.find((p) => p.name === r.name)?.available ?? r.branches]));

  /* ----- General ----- */
  const nameInput = h('input', { type: 'text', value: draft.name ?? '', required: true });
  const days = draft.days ?? 60;
  const period = select([...new Set([...PERIODS, days])].sort((a, b) => a - b).map((d) => [d, `Last ${d} days`]), days);

  /* ----- Flow rules ----- */
  const flow = draft.flow === false ? null : { ...DEFAULT_FLOW, ...draft.flow };
  const flowOn = h('input', { type: 'checkbox', checked: Boolean(flow) });
  const integration = select(INTEGRATION, flow?.integration ?? DEFAULT_FLOW.integration);
  const promotion = select(PROMOTION, flow?.promotion ?? DEFAULT_FLOW.promotion);
  const syncFlow = () => { integration.disabled = !flowOn.checked; promotion.disabled = !flowOn.checked; };
  flowOn.addEventListener('change', syncFlow);
  syncFlow();

  /* ----- Repos ----- */
  const repoList = h('div', { class: 'repo-list' });

  const renderRepos = () => {
    repoList.replaceChildren(...(draft.repos.length ? draft.repos.map(repoRow) : [h('p', { class: 'muted' }, 'No repos yet. Add one below.')]));
  };

  const repoRow = (repo, i) => {
    const { branches } = repo;
    const addable = (available.get(repo) ?? []).filter((b) => !branches.includes(b));
    const chips = branches.flatMap((b, j) => [
      j > 0 ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→') : null,
      h('span', { class: `bchip${j === 0 ? ' first' : ''}`, title: j === 0 ? 'Features land here' : `Promoted from ${branches[j - 1]}` },
        j > 0 ? h('button', {
          type: 'button', class: 'bchip-btn', 'aria-label': `Move ${b} earlier`, title: 'Move earlier',
          onclick: () => { [branches[j - 1], branches[j]] = [branches[j], branches[j - 1]]; renderRepos(); },
        }, icon('left')) : null,
        h('span', { class: 'bchip-name' }, b),
        branches.length > 1 ? h('button', {
          type: 'button', class: 'bchip-btn', 'aria-label': `Remove ${b}`, title: 'Remove branch',
          onclick: () => { branches.splice(j, 1); renderRepos(); },
        }, icon('x')) : null),
    ]);

    return h('div', { class: 'repo-row' },
      h('div', { class: 'repo-row-head' },
        h('input', {
          type: 'text', class: 'repo-name', value: repo.name, 'aria-label': 'Repo name', spellcheck: 'false',
          oninput: (e) => { repo.name = e.target.value.trim(); },
        }),
        h('span', { class: 'source', title: sourceOf(repo) }, sourceLabel(repo)),
        h('button', {
          type: 'button', class: 'icon-btn danger', 'aria-label': `Remove ${repo.name}`, title: 'Remove repo',
          onclick: () => { draft.repos.splice(i, 1); available.delete(repo); renderRepos(); },
        }, icon('trash'))),
      h('div', { class: 'branch-list' },
        chips,
        addable.length ? h('select', {
          class: 'add', 'aria-label': `Add a branch to ${repo.name}`,
          onchange: (e) => { if (e.target.value) { branches.push(e.target.value); renderRepos(); } },
        }, h('option', { value: '' }, '+ branch'), addable.map((b) => h('option', { value: b }, b))) : null));
  };

  /* ----- Add repo ----- */
  const datalist = h('datalist', { id: 'repo-suggestions' });
  const addInput = h('input', {
    type: 'text', list: 'repo-suggestions', placeholder: 'Git URL, GitHub org/repo or local folder', 'aria-label': 'Repo to add', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addRepo(); } },
  });
  const addBtn = h('button', { type: 'button', onclick: () => addRepo() }, 'Add repo');
  const addMsg = h('div', { class: 'state error', hidden: true });

  const uniqueName = (base) => {
    let name = base;
    for (let n = 2; draft.repos.some((r) => r.name === name); n++) name = `${base}-${n}`;
    return name;
  };

  async function addRepo() {
    const input = addInput.value.trim();
    if (!input) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Reading branches…';
    addMsg.hidden = true;
    try {
      const found = await api('/api/inspect', json('POST', { input }));
      const repo = { name: uniqueName(found.name), ...found.source, branches: found.pipeline.length ? found.pipeline : [found.branches[0]] };
      if (draft.repos.some((r) => sameSource(r, repo))) throw new Error('That repo is already added.');
      draft.repos.push(repo);
      available.set(repo, found.branches);
      addInput.value = '';
      renderRepos();
    } catch (err) {
      addMsg.replaceChildren(icon('alert'), err.message);
      addMsg.hidden = false;
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add repo';
    }
  }

  api('/api/suggestions')
    .then((list) => datalist.replaceChildren(...list.map((item) => h('option', { value: item.value }, item.hint))))
    .catch(() => {});

  /* ----- Appearance ----- */
  const theme = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' },
    THEMES.map(([value, label]) => h('label', {},
      h('input', { type: 'radio', name: 'theme', value, checked: value === currentTheme(), onchange: () => setTheme(value) }),
      h('span', {}, label))));

  /* ----- Save ----- */
  const saveMsg = h('div', { class: 'state error save-msg', hidden: true });
  const saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Save');

  const fail = (msg) => {
    saveMsg.replaceChildren(icon('alert'), msg);
    saveMsg.hidden = false;
  };

  async function save(e) {
    e.preventDefault();
    saveMsg.hidden = true;
    const body = {
      ...draft,
      name: nameInput.value.trim(),
      days: Number(period.value),
      flow: flowOn.checked ? { integration: integration.value, promotion: promotion.value } : false,
    };
    if (!body.name) return fail('Give the project a name.');
    if (!body.repos.length) return fail('Add at least one repo.');
    const names = body.repos.map((r) => r.name);
    const bad = names.find((n) => !/^[\w.-]+$/.test(n));
    if (bad !== undefined) return fail(`Repo name "${bad}" can only use letters, digits, ".", "_" or "-".`);
    if (new Set(names).size !== names.length) return fail('Two repos have the same name.');

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api('/api/config', json('PUT', body));
      dialog.close();
      await onSaved();
    } catch (err) {
      fail(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  renderRepos();
  dialog.replaceChildren(h('form', { class: 'modal-body', onsubmit: save },
    h('header', { class: 'modal-head' },
      h('div', {},
        h('h2', { id: 'settings-title' }, 'Settings'),
        h('div', { class: 'muted file' }, `Saved to ${loaded.file}`)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: () => dialog.close() }, icon('x'))),

    h('div', { class: 'modal-content' },
      h('section', { class: 'grid-2' },
        field('Project name', nameInput),
        field('Period', period, 'How far back the graph and flow checks look')),

      h('section', {},
        h('h3', {}, 'Flow rules'),
        h('p', { class: 'section-hint' }, 'What the flow checks expect. Show or hide the checks with Flow checks in the header.'),
        h('label', { class: 'check' }, flowOn, 'Check the branch flow'),
        h('div', { class: 'grid-2' },
          field('Into the first branch', integration, 'How features land, e.g. in development'),
          field('Into later branches', promotion, 'How promotions land, e.g. in test and main'))),

      h('section', {},
        h('h3', {}, 'Repos'),
        h('p', { class: 'section-hint' }, 'Branches in promotion order. The first is where features land.'),
        repoList,
        h('div', { class: 'add-repo' }, addInput, addBtn, datalist),
        addMsg),

      h('section', {},
        h('h3', {}, 'Appearance'),
        h('p', { class: 'section-hint' }, 'For this browser only. Applies right away, without Save.'),
        theme)),

    h('footer', { class: 'modal-foot' },
      saveMsg,
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      saveBtn)));
  nameInput.focus();
}
