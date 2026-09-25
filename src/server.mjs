import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, formatConfig, isSafeRef, parseConfig, sanitizeConfig, tilde } from './config.mjs';
import { ensureRepo, fetchRepo, listBranches, webUrlOf } from './git.mjs';
import { buildRepoData } from './repo-data.mjs';
import { findSources, inspect, suggestPipeline } from './setup.mjs';

const PUBLIC = path.join(ROOT, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/remote.js': ['remote.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_DAYS = 3650;
const MAX_BODY = 1024 * 1024;


export async function fetchAll(config, log = () => {}) {
  const errors = {};
  await Promise.all(config.repos.map(async (repo) => {
    try {
      await fetchRepo(repo);
      log(`  fetched ${repo.name}`);
    } catch (err) {
      errors[repo.name] = err.message;
      log(`  fetch failed for ${repo.name}: ${err.message}`);
    }
  }));
  return errors;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

/** Repo suggestions for the settings page: GitHub orgs/account (gh CLI) and local clones. Cached per server run. */
let suggestions = null;
async function loadSuggestions() {
  const sources = await findSources();
  const lists = await Promise.all(sources.map((src) => src.load().catch(() => [])));
  return lists.flat().map(({ value, hint }) => ({ value, hint }));
}

/**
 * Serve the page and API on 127.0.0.1. Resolves to { port, server }; port 0 picks a free one.
 * `state.config` is swapped on save, so every handler reads it at request time.
 */
export function startServer(config, { port, state }) {
  state.config = config;

  const server = http.createServer(async (req, res) => {
    // Only answer our own origin: blocks DNS rebinding and cross-site requests to the local API.
    const origin = `http://${req.headers.host}`;
    if (!state.hosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== origin)) {
      return send(res, 403, { error: 'Forbidden' });
    }
    const url = new URL(req.url, origin);
    const cfg = state.config;

    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, await readFile(path.join(PUBLIC, file)), type);
      }

      if (req.method === 'GET' && url.pathname === '/api/project') {
        const repos = await Promise.all(cfg.repos.map(async (repo) => {
          try {
            const available = await listBranches(repo);
            return { name: repo.name, branches: repo.branches, available, webUrl: await webUrlOf(repo) };
          } catch (err) {
            return { name: repo.name, branches: repo.branches, available: [], error: err.message };
          }
        }));
        return send(res, 200, {
          name: cfg.name, days: cfg.days, flow: cfg.flow, repos,
          fetchedAt: state.fetchedAt, fetchErrors: state.fetchErrors,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/repo') {
        const repo = cfg.repos.find((r) => r.name === url.searchParams.get('name'));
        if (!repo) return send(res, 404, { error: 'Unknown repo' });
        const days = Math.min(MAX_DAYS, Math.max(1, parseInt(url.searchParams.get('days'), 10) || cfg.days));
        const extras = (url.searchParams.get('extra') || '').split(',').filter(Boolean);
        if (!extras.every(isSafeRef)) return send(res, 400, { error: 'Invalid branch name' });
        return send(res, 200, await buildRepoData(repo, { days, extras, flow: cfg.flow }));
      }

      if (req.method === 'POST' && url.pathname === '/api/fetch') {
        state.fetchErrors = await fetchAll(cfg);
        state.fetchedAt = Date.now();
        return send(res, 200, { fetchedAt: state.fetchedAt, fetchErrors: state.fetchErrors });
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const raw = JSON.parse(await readFile(cfg.file, 'utf8'));
        return send(res, 200, { file: tilde(cfg.file), config: sanitizeConfig(raw) });
      }

      // Validate, make sure every repo is reachable (clones new URL repos), then write and swap in.
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const raw = sanitizeConfig(await readJson(req));
        let next;
        try {
          next = parseConfig(raw, cfg.file);
        } catch (err) {
          return send(res, 400, { error: err.message.replace(/^[^:]+: /, '') });
        }
        const failed = [];
        await Promise.all(next.repos.map((repo) => ensureRepo(repo).catch((err) => failed.push(`${repo.name}: ${err.message}`))));
        if (failed.length) return send(res, 400, { error: failed.join('\n') });
        await writeFile(cfg.file, formatConfig(raw));
        state.config = next;
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/inspect') {
        const { input } = await readJson(req);
        if (typeof input !== 'string' || !input.trim()) return send(res, 400, { error: 'Enter a URL, org/repo or folder' });
        try {
          const found = await inspect(input.trim());
          return send(res, 200, { ...found, pipeline: suggestPipeline(found.head, found.branches) });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/suggestions') {
        suggestions ??= loadSuggestions().catch(() => { suggestions = null; return []; });
        return send(res, 200, await suggestions);
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(err.message);
      return send(res, err.status ?? 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attemptsLeft) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(p + 1, attemptsLeft - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        state.hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve({ port: actual, server });
      });
    };
    tryListen(port, 10);
  });
}
