import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, tempDir } from './fixture.mjs';

const BIN = fileURLToPath(new URL('../bin/branch-graph.mjs', import.meta.url));
let fx;
let env;

const run = (...args) => {
  const res = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: res.status, out: res.stdout, err: res.stderr };
};

before(() => {
  fx = createFixture();
  env = { ...process.env, BRANCH_GRAPH_CONFIG_DIR: tempDir('branch-graph-configs-'), BRANCH_GRAPH_CACHE_DIR: tempDir('branch-graph-cache-'), NO_COLOR: '1' };
});

test('--help and --version', () => {
  assert.match(run('--help').out, /branch-graph status \[config\]/);
  assert.match(run('--version').out, /^\d+\.\d+\.\d+/);
  assert.equal(run('--bogus').code, 1);
});

test('init without prompts detects the pipeline and saves a config', () => {
  const res = run('init', '--name', 'Acme', '--repo', fx.work);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /api: development → test → main/);

  const saved = JSON.parse(readFileSync(path.join(env.BRANCH_GRAPH_CONFIG_DIR, 'acme.local.json'), 'utf8'));
  assert.deepEqual(saved.repos[0].branches, ['development', 'test', 'main']);
  assert.deepEqual(saved.flow, { integration: 'squash', promotion: 'merge' });

  assert.equal(run('init', '--name', 'Acme', '--repo', fx.work).code, 1, 'refuses to overwrite');
  assert.equal(run('init', '--name', 'Acme', '--repo', `${fx.work}=main,test`, '--force', '--no-flow').code, 0);
  const custom = JSON.parse(readFileSync(path.join(env.BRANCH_GRAPH_CONFIG_DIR, 'acme.local.json'), 'utf8'));
  assert.deepEqual(custom.repos[0].branches, ['main', 'test']);
  assert.equal(custom.flow, false);

  assert.equal(run('init', '--name', 'Acme', '--repo', `${fx.work}=nope`, '--force').code, 1, 'unknown branch');
});

test('status prints text and JSON', () => {
  assert.equal(run('init', '--name', 'Acme', '--repo', fx.work, '--force').code, 0);

  const text = run('status', 'acme.local', '--no-fetch');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /development → test\s+1 commit/);

  const json = run('status', 'acme.local', '--no-fetch', '--json');
  assert.equal(json.code, 0, json.err);
  const status = JSON.parse(json.out);
  assert.equal(status.project, 'Acme');
  assert.deepEqual(status.repos[0].pairs.map((p) => p.state), ['pending', 'pending']);
  assert.equal(status.repos[0].pairs[0].pending.commits[0].subject, 'Add settings page (#9)');

  assert.equal(run('status', 'missing-config').code, 1);
});
