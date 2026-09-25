import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

/** Run git without a shell. Resolves stdout, rejects with stderr in the message. */
export function git(cwd, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: ENV, timeout, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = err.killed ? `timed out after ${timeout / 1000}s` : (stderr.trim() || err.message);
        reject(new Error(`git ${args.join(' ')}: ${reason}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Map over items with at most `limit` promises in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Local clone: check it is a repo. URL repo: bare, blobless clone into the cache dir on first use. */
export async function ensureRepo(repo) {
  if (!repo.url) {
    if (!(await exists(repo.dir))) throw new Error(`${repo.name}: path not found: ${repo.dir}`);
    await git(repo.dir, ['rev-parse', '--git-dir']);
    return;
  }
  if (await exists(repo.dir)) return;
  await mkdir(path.dirname(repo.dir), { recursive: true });
  await git(path.dirname(repo.dir), ['clone', '--bare', '--filter=blob:none', '--quiet', repo.url, repo.dir], { timeout: 300_000 });
  // Bare clones map heads to refs/heads; use remote-tracking refs so local and URL repos read the same.
  await git(repo.dir, ['config', `remote.${repo.remote}.fetch`, `+refs/heads/*:refs/remotes/${repo.remote}/*`]);
  await fetchRepo(repo);
}

/** Update remote-tracking refs only. Never touches the working tree or local branches. */
export async function fetchRepo(repo) {
  await git(repo.dir, ['fetch', repo.remote, '--quiet'], { timeout: 120_000 });
}

/** Remote branch names, most recently updated first. */
export async function listBranches(repo) {
  const out = await git(repo.dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', `refs/remotes/${repo.remote}/`]);
  const prefix = `refs/remotes/${repo.remote}/`;
  return out.split('\n')
    .filter((r) => r.startsWith(prefix))
    .map((r) => r.slice(prefix.length))
    .filter((b) => b && b !== 'HEAD');
}

/** https web URL of a GitHub-style remote, or null. */
export async function webUrlOf(repo) {
  if (repo.webUrl) return repo.webUrl.replace(/\/$/, '');
  let url = repo.url;
  if (!url) {
    try { url = (await git(repo.dir, ['remote', 'get-url', repo.remote])).trim(); } catch { return null; }
  }
  const ssh = url.match(/^[\w.-]+@([\w.-]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?\/?$/);
  if (http) return `https://${http[1]}/${http[2]}`;
  return null;
}
