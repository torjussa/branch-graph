import { buildRepoData } from './repo-data.mjs';

const iso = (sec) => new Date(sec * 1000).toISOString();
const commit = (c) => ({ sha: c.h, subject: c.s, author: c.an, ...(c.cd && { date: iso(c.cd) }) });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Promotion status for every repo in the config, as plain data (the shape of `status --json`). */
export async function collectStatus(config, { days = config.days, fetchedAt = null, fetchErrors = {} } = {}) {
  const repos = await Promise.all(config.repos.map(async (repo) => {
    try {
      return repoStatus(await buildRepoData(repo, { days, flow: config.flow }), fetchErrors[repo.name]);
    } catch (err) {
      return { name: repo.name, error: err.message };
    }
  }));
  return {
    project: config.name,
    days,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    flowChecks: config.flow ?? false,
    repos,
  };
}

function repoStatus(d, fetchError) {
  const ownerOf = (sha) => d.pipeline.find((b) => d.branches[b].chain.includes(sha));
  const pairs = d.status.map((st) => ({
    from: st.from,
    to: st.to,
    // same-code: commits differ but the code does not. diverged: nothing to promote, but `to` has changes `from` lacks.
    state: !st.diff ? (st.ahead.n || st.behind.n ? 'same-code' : 'in-sync') : st.ahead.n ? 'pending' : 'diverged',
    pending: { count: st.ahead.n, capped: st.ahead.capped, commits: st.ahead.list.map(commit) },
    missingUpstream: { count: st.behind.n, capped: st.behind.capped, commits: st.behind.list.map(commit) },
    diff: st.diff,
    fastForward: st.fastForward,
    compareUrl: d.webUrl ? `${d.webUrl}/compare/${encodeURIComponent(st.to)}...${encodeURIComponent(st.from)}` : null,
  }));
  const flowIssues = Object.values(d.commits)
    .filter((c) => c.flag)
    .sort((a, b) => b.cd - a.cd)
    .map((c) => ({ level: c.flag.level, message: c.flag.msg, branch: ownerOf(c.sha) ?? null, sha: c.sha, subject: c.s, author: c.an, date: iso(c.cd) }));

  return {
    name: d.name,
    webUrl: d.webUrl,
    ...(fetchError && { fetchError }),
    ...(d.missing.length && { missingBranches: d.missing }),
    branches: Object.fromEntries(d.pipeline.map((b) => {
      const tip = d.commits[d.branches[b].tip];
      return [b, tip ? { sha: tip.sha, subject: tip.s, date: iso(tip.cd) } : null];
    })),
    pairs,
    flowIssues,
  };
}

/** Human-readable summary of `collectStatus` output. */
export function formatStatus(status, { color = false } = {}) {
  const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = paint('1');
  const dim = paint('2');
  const red = paint('31');
  const green = paint('32');
  const yellow = paint('33');

  const lines = [`${bold(status.project)} ${dim(`· last ${status.days} days`)}`];
  const width = Math.max(0, ...status.repos.flatMap((r) => (r.pairs ?? []).map((p) => `${p.from} → ${p.to}`.length)));
  let errors = 0;
  let warnings = 0;

  for (const repo of status.repos) {
    lines.push('', bold(repo.name));
    if (repo.error) {
      lines.push(`  ${red(repo.error)}`);
      continue;
    }
    if (repo.fetchError) lines.push(`  ${red(`fetch failed: ${repo.fetchError}`)}`);
    if (repo.missingBranches) lines.push(`  ${red(`not on remote: ${repo.missingBranches.join(', ')}`)}`);
    if (!repo.pairs.length && !repo.missingBranches) lines.push(`  ${dim('only one branch configured')}`);
    for (const p of repo.pairs) {
      const name = `${p.from} → ${p.to}`.padEnd(width);
      let state;
      if (p.state === 'in-sync') state = green('in sync');
      else if (p.state === 'same-code') state = green('same code');
      else if (p.state === 'diverged') state = `nothing to promote, ${plural(p.diff.files, 'file')} ${p.diff.files === 1 ? 'differs' : 'differ'}`;
      else state = `${plural(p.pending.count, 'commit')}${p.pending.capped ? '+' : ''}, ${plural(p.diff.files, 'file')} (+${p.diff.ins} −${p.diff.del})`;
      lines.push(`  ${name}  ${state}`);
      const pad = ' '.repeat(width + 4);
      if (p.missingUpstream.count) lines.push(`${pad}${red(`${plural(p.missingUpstream.count, 'commit')} on ${p.to} not in ${p.from}`)}`);
      if (p.fastForward) lines.push(`${pad}${dim(`${p.to} was fast-forwarded (no merge commit)`)}`);
    }
    errors += repo.flowIssues.filter((f) => f.level === 'error').length;
    warnings += repo.flowIssues.filter((f) => f.level === 'warn').length;
  }

  if (status.flowChecks) {
    lines.push('', errors || warnings
      ? `Flow: ${errors ? red(plural(errors, 'error')) : '0 errors'}, ${warnings ? yellow(plural(warnings, 'warning')) : '0 warnings'} ${dim('(--json for details)')}`
      : `Flow: ${green('no issues')}`);
  }
  return lines.join('\n');
}
