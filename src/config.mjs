import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Per-user folders: ~/.config and ~/.cache (XDG), %APPDATA% and %LOCALAPPDATA% on Windows. Env vars override. */
function userDir(kind) {
  if (process.platform === 'win32') {
    const base = kind === 'config' ? process.env.APPDATA : process.env.LOCALAPPDATA;
    return path.join(base || path.join(os.homedir(), 'AppData', kind === 'config' ? 'Roaming' : 'Local'), 'branch-graph');
  }
  const base = kind === 'config' ? process.env.XDG_CONFIG_HOME : process.env.XDG_CACHE_HOME;
  return path.join(base || path.join(os.homedir(), kind === 'config' ? '.config' : '.cache'), 'branch-graph');
}

export const CONFIG_DIR = path.resolve(process.env.BRANCH_GRAPH_CONFIG_DIR || userDir('config'));
const CACHE_DIR = path.resolve(process.env.BRANCH_GRAPH_CACHE_DIR || userDir('cache'));
const OLD_CONFIG_DIR = path.join(ROOT, 'configs');

/** Shorten paths under the home folder to ~ for display. */
export const tilde = (p) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

/** Versions before 0.1 kept configs next to the code. Copy them to the user config folder once. */
export async function migrateOldConfigs() {
  if (process.env.BRANCH_GRAPH_CONFIG_DIR || !existsSync(OLD_CONFIG_DIR)) return [];
  const old = (await readdir(OLD_CONFIG_DIR)).filter((f) => f.endsWith('.json'));
  const moved = old.filter((f) => !existsSync(path.join(CONFIG_DIR, f)));
  if (!moved.length) return [];
  await mkdir(CONFIG_DIR, { recursive: true });
  await Promise.all(moved.map((f) => copyFile(path.join(OLD_CONFIG_DIR, f), path.join(CONFIG_DIR, f))));
  return moved;
}

const FLOW_MODES = {
  integration: ['squash', 'merge', 'any'],
  promotion: ['merge', 'squash', 'any'],
};

/** Branch/remote names are passed to git as arguments, so keep them to ref-safe characters. */
export function isSafeRef(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9._\/-]+$/.test(name)
    && !name.startsWith('-')
    && !name.includes('..')
    && !name.startsWith('/') && !name.endsWith('/');
}

export function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Resolve a CLI argument to a config file: a path, or a name in the config folder. */
export async function resolveConfigPath(arg) {
  if (arg) {
    if (existsSync(arg)) return path.resolve(arg);
    const named = path.join(CONFIG_DIR, arg.endsWith('.json') ? arg : `${arg}.json`);
    if (existsSync(named)) return named;
    throw new Error(`Config not found: ${arg}\n${await describeConfigs()}`);
  }
  const names = await configNames();
  if (names.length === 1) return path.join(CONFIG_DIR, `${names[0]}.json`);
  throw new Error(`Pass a config name or path.\n${await describeConfigs()}`);
}

export async function configNames() {
  const files = existsSync(CONFIG_DIR) ? await readdir(CONFIG_DIR) : [];
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

async function describeConfigs() {
  const names = await configNames();
  return names.length ? `Available in ${tilde(CONFIG_DIR)}: ${names.join(', ')}` : `No configs in ${tilde(CONFIG_DIR)}. Run: branch-graph init`;
}

// Kept with the cache, so the config folder only holds files people write.
const LAST_USED = path.join(CACHE_DIR, 'last-config');

/** Remember a config from the config folder as the one to run when no name is given. */
export async function rememberConfig(file) {
  if (path.dirname(file) !== CONFIG_DIR) return;
  // Best effort: a read-only cache folder shouldn't stop a run.
  await mkdir(CACHE_DIR, { recursive: true })
    .then(() => writeFile(LAST_USED, `${path.basename(file, '.json')}\n`))
    .catch(() => {});
}

/** Config to run when no name is given: the one used last, else the most recently saved. */
export async function defaultConfig(names) {
  const last = await readFile(LAST_USED, 'utf8').then((s) => s.trim(), () => '');
  if (names.includes(last)) return { name: last, why: 'last used' };
  const saved = await Promise.all(names.map((n) => stat(path.join(CONFIG_DIR, `${n}.json`)).then((s) => s.mtimeMs)));
  return { name: names[saved.indexOf(Math.max(...saved))], why: 'newest' };
}

export const URL_PATTERN = /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/;

export async function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid config ${file}: ${err.message}`);
  }
  return parseConfig(raw, file);
}

/** Validate a raw config object and resolve it for use. Throws with a readable message. */
export function parseConfig(raw, file) {
  const fail = (msg) => { throw new Error(`${path.basename(file)}: ${msg}`); };
  const baseDir = path.dirname(file);

  if (!raw || typeof raw !== 'object') fail('must be a JSON object');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim())) fail('"name" must be a non-empty string');
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) fail('"repos" must be a non-empty array');

  const days = raw.days ?? 60;
  if (!Number.isInteger(days) || days < 1) fail('"days" must be a positive integer');

  let flow = null;
  if (raw.flow !== false) {
    flow = { integration: 'squash', promotion: 'merge', ...(raw.flow ?? {}) };
    for (const [key, modes] of Object.entries(FLOW_MODES)) {
      if (!modes.includes(flow[key])) fail(`"flow.${key}" must be one of ${modes.join(', ')}`);
    }
  }

  const seen = new Set();
  const repos = raw.repos.map((r, i) => {
    const where = `repos[${i}]`;
    if (!r || typeof r.name !== 'string' || !/^[\w.-]+$/.test(r.name)) fail(`${where}.name must use letters, digits, ".", "_" or "-"`);
    if (seen.has(r.name)) fail(`duplicate repo name "${r.name}"`);
    seen.add(r.name);
    if (!r.path === !r.url) fail(`${r.name} needs exactly one of "path" or "url"`);
    if (r.path !== undefined && typeof r.path !== 'string') fail(`${r.name}.path is invalid`);
    if (r.url !== undefined && (typeof r.url !== 'string' || !URL_PATTERN.test(r.url))) fail(`${r.name}.url must start with https://, ssh://, git@ or file://`);
    if (!Array.isArray(r.branches) || r.branches.length === 0) fail(`${r.name} needs at least one branch`);
    for (const b of r.branches) if (!isSafeRef(b)) fail(`${r.name}: invalid branch name ${JSON.stringify(b)}`);
    if (new Set(r.branches).size !== r.branches.length) fail(`${r.name} lists a branch twice`);
    const remote = r.remote ?? 'origin';
    if (!isSafeRef(remote)) fail(`${r.name}: invalid remote ${JSON.stringify(remote)}`);
    if (r.webUrl !== undefined && (typeof r.webUrl !== 'string' || !/^https?:\/\//.test(r.webUrl))) fail(`${r.name}.webUrl must be an http(s) URL`);

    const dir = r.path
      ? path.resolve(baseDir, expandHome(r.path))
      : path.join(CACHE_DIR, `${r.name.replace(/[^\w.-]/g, '_')}-${createHash('sha1').update(r.url).digest('hex').slice(0, 8)}.git`);

    return { name: r.name, dir, url: r.url ?? null, remote, branches: r.branches, webUrl: r.webUrl ?? null };
  });

  return {
    name: raw.name ?? path.basename(file, '.json'),
    file,
    days,
    flow,
    repos,
  };
}

/** Keep only known fields, in a stable order, so saved files stay tidy. */
export function sanitizeConfig(raw) {
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
  return {
    ...pick(raw, ['name', 'days', 'flow']),
    repos: Array.isArray(raw?.repos) ? raw.repos.map((r) => pick(r, ['name', 'url', 'path', 'remote', 'webUrl', 'branches'])) : raw?.repos,
  };
}

/** Compact JSON: one repo field per line, arrays and small objects inline. */
export function formatConfig(cfg) {
  const inline = (v) => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
    return JSON.stringify(v);
  };
  const repo = (r) => `    {\n${Object.entries(r).map(([k, v]) => `      ${JSON.stringify(k)}: ${inline(v)}`).join(',\n')}\n    }`;
  const top = Object.entries(cfg).filter(([k]) => k !== 'repos').map(([k, v]) => `  ${JSON.stringify(k)}: ${inline(v)},`);
  return `{\n${top.join('\n')}\n  "repos": [\n${cfg.repos.map(repo).join(',\n')}\n  ]\n}\n`;
}
