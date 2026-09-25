import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatConfig, loadConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { createFixture } from './fixture.mjs';

let fx;
let file;
let base;
let server;

before(async () => {
  fx = createFixture();
  file = path.join(fx.root, 'acme.json');
  writeFileSync(file, formatConfig(fx.config));
  const state = { fetchedAt: null, fetchErrors: {}, hosts: new Set() };
  const started = await startServer(await loadConfig(file), { port: 0, state });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => server.close());

const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the page and project data', async () => {
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Branch graph<\/title>/);
  const project = await (await fetch(`${base}/api/project`)).json();
  assert.equal(project.name, 'Acme');
  assert.ok(project.repos[0].available.includes('feature/chart'));
});

test('rejects other origins and hosts', async () => {
  assert.equal((await fetch(`${base}/api/project`, { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/fetch`, { method: 'POST', headers: { Origin: 'http://evil.example' } })).status, 403);
});

test('rejects unsafe branch names in queries', async () => {
  assert.equal((await fetch(`${base}/api/repo?name=api&extra=--upload-pack=x`)).status, 400);
});

test('config: invalid saves are refused and leave the file alone', async () => {
  const before = readFileSync(file, 'utf8');
  const res = await fetch(`${base}/api/config`, json('PUT', { name: 'Acme', repos: [{ name: 'api', url: 'ext::sh -c id', branches: ['main'] }] }));
  assert.equal(res.status, 400);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('config: a valid save writes the file and takes effect', async () => {
  const { config } = await (await fetch(`${base}/api/config`)).json();
  config.name = 'Acme 2';
  config.days = 14;
  config.repos[0].branches = ['development', 'test'];
  const res = await fetch(`${base}/api/config`, json('PUT', config));
  assert.equal(res.status, 200, await res.clone().text());

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.days, 14);
  assert.deepEqual(saved.repos[0].branches, ['development', 'test']);
  const project = await (await fetch(`${base}/api/project`)).json();
  assert.equal(project.name, 'Acme 2');
});

test('inspect reads a repo\'s branches and suggests a pipeline', async () => {
  const res = await (await fetch(`${base}/api/inspect`, json('POST', { input: fx.work }))).json();
  assert.equal(res.head, 'development');
  assert.deepEqual(res.pipeline, ['development', 'test', 'main']);
});
