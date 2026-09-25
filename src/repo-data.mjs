import { git, pool, listBranches, webUrlOf } from './git.mjs';

const LOG_FORMAT = ['%H', '%P', '%an', '%at', '%ct', '%s', '%b'].join('%x1f');
const MIN_PER_BRANCH = 3;   // keep a few commits per branch even when it is quiet, so every lane has its tip
const MAX_WALK = 3000;
const LIST_CAP = 100;
const INC_WALK = 2000;

/** Commits merged in by a merge commit never change, so cache them across requests. */
const includedCache = new Map();

function records(out) {
  return out.split('\0').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => r.split('\x1f'));
}

function parseSubject(subject, remote) {
  let m = subject.match(/^Merge pull request #(\d+) from [^\s/]+\/(\S+)/);
  if (m) return { pr: +m[1], from: m[2] };
  m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (m) return { pr: null, from: m[1].startsWith(`${remote}/`) ? m[1].slice(remote.length + 1) : m[1] };
  m = subject.match(/\(#(\d+)\)\s*$/);
  return { pr: m ? +m[1] : null, from: null };
}

async function firstParentChain(repo, ref, cutoff) {
  const out = await git(repo.dir, ['log', '--first-parent', `--max-count=${MAX_WALK}`, `--format=${LOG_FORMAT}`, '-z', ref, '--']);
  const rows = records(out);
  let n = 0;
  while (n < rows.length && (n < MIN_PER_BRANCH || +rows[n][4] >= cutoff)) n++;
  return rows.slice(0, n).map(([sha, parents, author, at, ct, subject, body]) => ({
    sha,
    p: parents ? parents.split(' ') : [],
    an: author,
    ad: +at,
    cd: +ct,
    s: subject,
    b: (body ?? '').trim(),
    ...parseSubject(subject, repo.remote),
  }));
}

/** Commits a merge brought in (reachable from 2nd parent, not 1st). */
async function included(repo, sha) {
  const key = `${repo.dir}\0${sha}`;
  if (includedCache.has(key)) return includedCache.get(key);
  const out = await git(repo.dir, ['log', `--max-count=${INC_WALK}`, '--format=%H%x1f%P%x1f%s%x1f%an', '-z', `${sha}^1..${sha}^2`, '--']);
  const rows = records(out);
  const nonMerges = rows.filter(([, parents]) => parents.split(' ').length === 1);
  const inc = {
    n: nonMerges.length,
    capped: rows.length >= INC_WALK,
    all: rows.map(([h]) => h),
    list: nonMerges.slice(0, LIST_CAP).map(([h, , s, an]) => ({ h, s, an })),
  };
  includedCache.set(key, inc);
  return inc;
}

async function commitList(repo, range) {
  const out = await git(repo.dir, ['log', '--no-merges', '--max-count=500', '--format=%H%x1f%s%x1f%an%x1f%ct', '-z', range, '--']);
  const rows = records(out);
  return {
    n: rows.length,
    capped: rows.length >= 500,
    list: rows.slice(0, LIST_CAP).map(([h, s, an, ct]) => ({ h, s, an, cd: +ct })),
  };
}

function parseShortstat(out) {
  const text = out.trim();
  if (!text) return null;
  const num = (re) => +(text.match(re)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), ins: num(/(\d+) insertions?/), del: num(/(\d+) deletions?/) };
}

/**
 * Label each commit on a pipeline branch with how it landed, and flag the ones that break the flow.
 * A commit is judged on the first (most upstream) pipeline branch whose first-parent chain holds it.
 */
function classify({ pipeline, branches, commits, flow }) {
  const chainSets = Object.fromEntries(pipeline.map((b) => [b, new Set(branches[b].chain)]));
  const sourceOf = (c) => {
    const p2 = c.p[1];
    for (const b of pipeline) if (chainSets[b].has(p2)) return b;
    return c.from && pipeline.includes(c.from) ? c.from : null;
  };

  pipeline.forEach((branch, i) => {
    const upstream = pipeline[i - 1];
    const downstream = new Set(pipeline.slice(i + 1));
    for (const sha of branches[branch].chain) {
      const c = commits[sha];
      if (c.role) continue;
      if (pipeline.slice(0, i).some((u) => chainSets[u].has(sha))) continue;

      const merge = c.p.length > 1;
      const src = merge ? sourceOf(c) : null;
      const direct = c.pr ? `Squash merge (#${c.pr})` : 'Direct commit';

      if (!merge) c.role = direct;
      else if (downstream.has(src)) c.role = `Back-merge from ${src}`;
      else if (i > 0 && src === upstream) c.role = `Promotion from ${upstream}`;
      else c.role = `Merge from ${src ?? c.from ?? 'another branch'}`;

      if (!flow || (merge && downstream.has(src))) continue;
      const mode = i === 0 ? flow.integration : flow.promotion;

      if (i === 0) {
        if (mode === 'squash' && merge) c.flag = { level: 'warn', msg: `Merge commit on ${branch}. Expected a squash merge.` };
        else if (mode === 'squash' && !c.pr) c.flag = { level: 'warn', msg: `Commit on ${branch} without a PR. Expected a squash merge from a feature branch.` };
        else if (mode === 'merge' && !merge) c.flag = { level: 'warn', msg: `Direct commit on ${branch}. Expected a merge from a feature branch.` };
      } else if (mode === 'merge') {
        if (!merge) c.flag = { level: 'error', msg: `${direct} on ${branch}. Expected a merge commit from ${upstream}.` };
        else if (src !== upstream) c.flag = { level: 'error', msg: `Merged from ${src ?? c.from ?? 'another branch'} into ${branch}. Expected a merge from ${upstream}.` };
      } else if (mode === 'squash' && merge) {
        c.flag = { level: 'error', msg: `Merge commit on ${branch}. Expected a squash merge from ${upstream}.` };
      }
    }
  });
}

export async function buildRepoData(repo, { days, extras = [], flow }) {
  const available = await listBranches(repo);
  const avail = new Set(available);
  const pipeline = repo.branches.filter((b) => avail.has(b));
  const missing = repo.branches.filter((b) => !avail.has(b));
  const extra = [...new Set(extras)].filter((b) => avail.has(b) && !pipeline.includes(b));
  const ref = (b) => `refs/remotes/${repo.remote}/${b}`;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const commits = {};
  const branches = {};
  await Promise.all([...pipeline, ...extra].map(async (b) => {
    const chain = await firstParentChain(repo, ref(b), cutoff);
    for (const c of chain) commits[c.sha] ??= c;
    branches[b] = {
      tip: chain[0]?.sha ?? null,
      chain: chain.map((c) => c.sha),
      truncated: (chain.at(-1)?.p.length ?? 0) > 0,
    };
  }));

  const merges = Object.values(commits).filter((c) => c.p.length > 1);
  await pool(merges, 8, async (c) => { c.inc = await included(repo, c.sha); });

  // reach[a][b]: commits on a's first-parent chain (in the window) that b does not contain yet.
  const reach = {};
  const pairs = [];
  pipeline.forEach((a, i) => pipeline.slice(i + 1).forEach((b) => pairs.push([a, b])));
  await Promise.all(pairs.map(async ([a, b]) => {
    const out = await git(repo.dir, ['rev-list', '--first-parent', `--max-count=${branches[a].chain.length}`, ref(a), '--not', ref(b), '--']);
    (reach[a] ??= {})[b] = out.split('\n').filter(Boolean);
  }));

  const status = await Promise.all(pipeline.slice(1).map(async (b, i) => {
    const a = pipeline[i];
    const [ahead, behind, diff] = await Promise.all([
      commitList(repo, `${ref(b)}..${ref(a)}`),
      commitList(repo, `${ref(a)}..${ref(b)}`),
      git(repo.dir, ['diff', '--shortstat', ref(b), ref(a), '--']).then(parseShortstat),
    ]);
    // b's tip sits on a's own history: b was moved there without a merge commit.
    const fastForward = branches[a].chain.includes(branches[b].tip);
    return { from: a, to: b, ahead, behind, diff, fastForward };
  }));

  classify({ pipeline, branches, commits, flow });

  return {
    name: repo.name,
    webUrl: await webUrlOf(repo),
    pipeline,
    extras: extra,
    missing,
    available,
    branches,
    commits,
    reach,
    status,
  };
}
