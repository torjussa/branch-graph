import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteLabel, siteName, webUrlFromRemote } from '../public/remote.js';

test('remote URLs become repo web URLs on any host', () => {
  const cases = {
    'https://github.com/acme/api.git': 'https://github.com/acme/api',
    'https://token@github.com/acme/api/': 'https://github.com/acme/api',
    'git@github.com:acme/api.git': 'https://github.com/acme/api',
    'ssh://git@github.com/acme/api.git': 'https://github.com/acme/api',
    'ssh://git@git.acme.dev:2222/team/api.git': 'https://git.acme.dev/team/api',
    'https://git.acme.dev:8443/team/api.git': 'https://git.acme.dev:8443/team/api',
    'https://gitlab.com/acme/platform/api.git': 'https://gitlab.com/acme/platform/api',
  };
  for (const [remote, web] of Object.entries(cases)) assert.equal(webUrlFromRemote(remote), web, remote);
  assert.equal(webUrlFromRemote('file:///tmp/api.git'), null);
  assert.equal(webUrlFromRemote('/tmp/api'), null);
});

test('labels: org/repo on GitHub, host and path elsewhere', () => {
  assert.equal(remoteLabel('git@github.com:acme/api.git'), 'acme/api');
  assert.equal(remoteLabel('https://gitlab.com/acme/api.git'), 'gitlab.com/acme/api');
  assert.equal(remoteLabel('file:///tmp/api.git'), 'file:///tmp/api.git');
  assert.equal(siteName('https://github.com/acme/api'), 'GitHub');
  assert.equal(siteName('https://git.acme.dev:8443/team/api'), 'git.acme.dev:8443');
});
