import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.mjs reads its folders on import, so point them at a temp folder first.
const dir = mkdtempSync(path.join(os.tmpdir(), 'branch-graph-default-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
process.env.BRANCH_GRAPH_CONFIG_DIR = path.join(dir, 'config');
process.env.BRANCH_GRAPH_CACHE_DIR = path.join(dir, 'cache');
const { CONFIG_DIR, configNames, defaultConfig, rememberConfig } = await import('../src/config.mjs');

const save = (name, date) => {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  writeFileSync(file, '{}');
  utimesSync(file, new Date(date), new Date(date));
  return file;
};

test('without a name, the config used last runs, else the newest', async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const older = save('older', '2026-01-01');
  save('newer', '2026-02-01');
  const names = await configNames();

  assert.deepEqual(await defaultConfig(names), { name: 'newer', why: 'newest' });

  await rememberConfig(older);
  assert.deepEqual(await defaultConfig(names), { name: 'older', why: 'last used' });

  await rememberConfig(path.join(dir, 'elsewhere.json'));
  assert.equal((await defaultConfig(names)).name, 'older', 'files outside the config folder are not remembered');

  assert.deepEqual(await defaultConfig(['newer']), { name: 'newer', why: 'newest' }, 'a remembered config that is gone is skipped');
});
