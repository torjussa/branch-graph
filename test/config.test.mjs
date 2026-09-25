import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig, isSafeRef, parseConfig, sanitizeConfig } from '../src/config.mjs';

const valid = () => ({
  name: 'Acme',
  days: 30,
  flow: { integration: 'squash', promotion: 'merge' },
  repos: [{ name: 'api', url: 'https://github.com/acme/api.git', branches: ['development', 'test', 'main'] }],
});

test('parses a valid config and fills defaults', () => {
  const cfg = parseConfig({ repos: [{ name: 'api', url: 'git@github.com:acme/api.git', branches: ['main'] }] }, '/tmp/acme.json');
  assert.equal(cfg.name, 'acme');
  assert.equal(cfg.days, 60);
  assert.deepEqual(cfg.flow, { integration: 'squash', promotion: 'merge' });
  assert.equal(cfg.repos[0].remote, 'origin');
});

test('flow: false turns flow checks off', () => {
  assert.equal(parseConfig({ ...valid(), flow: false }, 'x.json').flow, null);
});

test('rejects configs that are unsafe or incomplete', () => {
  const cases = {
    'no repos': { ...valid(), repos: [] },
    'ext:: transport': { ...valid(), repos: [{ name: 'api', url: 'ext::sh -c id', branches: ['main'] }] },
    'option as branch': { ...valid(), repos: [{ name: 'api', url: 'https://x/y.git', branches: ['--upload-pack=x'] }] },
    'path and url': { ...valid(), repos: [{ name: 'api', url: 'https://x/y.git', path: '/tmp/y', branches: ['main'] }] },
    'duplicate names': { ...valid(), repos: [valid().repos[0], valid().repos[0]] },
    'branch twice': { ...valid(), repos: [{ name: 'api', url: 'https://x/y.git', branches: ['main', 'main'] }] },
    'bad flow mode': { ...valid(), flow: { integration: 'rebase' } },
    'bad days': { ...valid(), days: 0 },
  };
  for (const [label, raw] of Object.entries(cases)) {
    assert.throws(() => parseConfig(raw, 'x.json'), undefined, label);
  }
});

test('ref names that could be read as options are refused', () => {
  assert.ok(isSafeRef('feature/login-2'));
  for (const bad of ['-x', '--upload-pack=x', 'a..b', '/abs', 'trailing/', 'sp ace', '']) assert.equal(isSafeRef(bad), false, bad);
});

test('sanitize drops unknown fields and formatting round-trips', () => {
  const raw = { ...valid(), secret: 'x', repos: [{ ...valid().repos[0], extra: 1 }] };
  const clean = sanitizeConfig(raw);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.repos[0].extra, undefined);
  const text = formatConfig(clean);
  assert.deepEqual(JSON.parse(text), clean);
  assert.match(text, /"branches": \["development", "test", "main"\]/);
});
