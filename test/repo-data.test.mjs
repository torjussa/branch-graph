import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseConfig } from '../src/config.mjs';
import { buildRepoData } from '../src/repo-data.mjs';
import { collectStatus, formatStatus } from '../src/status.mjs';
import { createFixture } from './fixture.mjs';

let fx;
let config;
let data;
const bySubject = (subject) => Object.values(data.commits).find((c) => c.s === subject);

before(async () => {
  fx = createFixture();
  config = parseConfig(fx.config, path.join(fx.root, 'acme.json'));
  data = await buildRepoData(config.repos[0], { days: 60, flow: config.flow });
});

test('status per branch pair: pending commits, missing upstream, code diff', () => {
  const [devTest, testMain] = data.status;
  assert.deepEqual([devTest.from, devTest.to], ['development', 'test']);
  assert.deepEqual(devTest.ahead.list.map((c) => c.s), ['Add settings page (#9)']);
  assert.equal(devTest.behind.n, 0);
  assert.ok(devTest.diff.files > 0);

  assert.deepEqual(testMain.ahead.list.map((c) => c.s).sort(), ['Add export (#5)', 'Try new chart']);
  assert.deepEqual(testMain.behind.list.map((c) => c.s), ['Hotfix typo (#7)']);
  assert.equal(testMain.fastForward, false);
});

test('commits not yet in the next branch', () => {
  assert.deepEqual(data.reach.development.test.map((sha) => data.commits[sha].s), ['Add settings page (#9)']);
});

test('merges know what they brought in', () => {
  const promotion = bySubject('Merge pull request #8 from acme/development');
  assert.deepEqual(promotion.inc.list.map((c) => c.s).sort(), ['Add export (#5)', 'Try new chart']);
});

test('flow checks: roles and flags', () => {
  assert.equal(bySubject('Add login (#1)').role, 'Squash merge (#1)');
  assert.equal(bySubject('Add login (#1)').flag, undefined);
  assert.equal(bySubject('Merge pull request #3 from acme/development').role, 'Promotion from development');
  assert.equal(bySubject('Merge pull request #4 from acme/test').role, 'Promotion from test');

  assert.equal(bySubject('wip').flag.level, 'warn');
  assert.equal(bySubject('Merge pull request #6 from acme/feature/chart').flag.level, 'warn');
  assert.equal(bySubject('Hotfix typo (#7)').flag.level, 'error');
  assert.match(bySubject('Hotfix typo (#7)').flag.msg, /Expected a merge commit from test/);
});

test('no flags when flow checks are off', async () => {
  const off = await buildRepoData(config.repos[0], { days: 60, flow: null });
  assert.equal(Object.values(off.commits).filter((c) => c.flag).length, 0);
});

test('status summary as data and text', async () => {
  const status = await collectStatus(config);
  const [devTest, testMain] = status.repos[0].pairs;
  assert.equal(devTest.state, 'pending');
  assert.equal(testMain.missingUpstream.count, 1);
  assert.ok(status.repos[0].flowIssues.some((f) => f.level === 'error' && f.branch === 'main'));

  const text = formatStatus(status);
  assert.match(text, /development → test\s+1 commit, /);
  assert.match(text, /1 commit on main not in test/);
  assert.match(text, /Flow: 1 error/);
});
