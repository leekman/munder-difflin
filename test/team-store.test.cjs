'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { scopeKey, readFloorScope, writeFloorScope, listTeams, saveTeam, touchTeam, forgetTeam } =
  loadTs('src/main/teamStore.ts');
const { repoSlug } = loadTs('src/main/roster.ts');

const REPO = '/work/mono';
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-team-store-'));
const team = (summary, scope = ['core', 'live']) => ({ scope, summary, agents: [{ id: 'a1' }], queues: { a1: [] } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const teamDir = (home, scope) => path.join(home, 'teams', repoSlug(REPO), scopeKey(scope));

test('scopeKey is order-independent', () => {
  assert.equal(scopeKey(['live', 'core']), scopeKey(['core', 'live']));
  assert.ok(scopeKey([]).startsWith('all-'));
  assert.notEqual(scopeKey(['core']), scopeKey(['live']));
});

test('save, list, touch ordering', async () => {
  const home = tmpHome();
  const a = saveTeam(home, REPO, team('first'));
  await sleep(5);
  const b = saveTeam(home, REPO, team('second'));
  assert.deepEqual(listTeams(home, REPO, ['core', 'live']).map((t) => t.id), [b.id, a.id]);
  await sleep(5);
  touchTeam(home, REPO, ['live', 'core'], a.id);
  assert.deepEqual(listTeams(home, REPO, ['core', 'live']).map((t) => t.id), [a.id, b.id]);
  assert.equal(listTeams(home, REPO, ['core'])?.length, 0);
});

test('save with id updates in place', async () => {
  const home = tmpHome();
  const a = saveTeam(home, REPO, team('v1'));
  await sleep(5);
  const b = saveTeam(home, REPO, { ...team('v2'), id: a.id });
  assert.equal(b.id, a.id);
  assert.equal(b.createdAt, a.createdAt);
  const files = fs.readdirSync(teamDir(home, ['core', 'live']));
  assert.equal(files.length, 1);
  assert.equal(listTeams(home, REPO, ['core', 'live'])[0].summary, 'v2');
});

test('forgetTeam removes only that file', () => {
  const home = tmpHome();
  const a = saveTeam(home, REPO, team('a'));
  const b = saveTeam(home, REPO, team('b'));
  assert.equal(forgetTeam(home, REPO, ['core', 'live'], a.id), true);
  assert.equal(forgetTeam(home, REPO, ['core', 'live'], a.id), false);
  assert.deepEqual(listTeams(home, REPO, ['core', 'live']).map((t) => t.id), [b.id]);
});

test('floor scope round-trip', () => {
  const home = tmpHome();
  assert.equal(readFloorScope(home, REPO), null);
  writeFloorScope(home, REPO, { enabled: true, scope: ['live', 'core'] });
  assert.deepEqual(readFloorScope(home, REPO), { enabled: true, scope: ['core', 'live'] });
});

test('rejects unsafe scope paths', () => {
  const home = tmpHome();
  assert.throws(() => saveTeam(home, REPO, team('x', ['../x'])));
  assert.throws(() => writeFloorScope(home, REPO, { enabled: true, scope: ['../x'] }));
  assert.throws(() => listTeams(home, REPO, ['/abs']));
});

test('missing subproject is kept in stored scope', () => {
  const home = tmpHome();
  writeFloorScope(home, REPO, { enabled: true, scope: ['gone/dir'] });
  assert.deepEqual(readFloorScope(home, REPO).scope, ['gone/dir']);
  const t = saveTeam(home, REPO, team('s', ['gone/dir']));
  assert.deepEqual(listTeams(home, REPO, ['gone/dir'])[0].scope, ['gone/dir']);
  assert.equal(t.repoRoot, REPO);
});

test('validation and corrupted files', () => {
  const home = tmpHome();
  assert.throws(() => saveTeam(home, REPO, { scope: [], summary: '  ', agents: [], queues: {} }));
  assert.throws(() => saveTeam(home, REPO, { scope: [], summary: 's', agents: 'no', queues: {} }));
  assert.throws(() => saveTeam(home, REPO, { scope: [], summary: 's', agents: [], queues: [] }));
  assert.throws(() => saveTeam(home, REPO, { ...team('s'), id: '../evil' }));
  assert.throws(() => touchTeam(home, REPO, [], 'a/b'));
  assert.throws(() => forgetTeam(home, REPO, [], '..'));
  assert.equal(saveTeam(home, REPO, team('x'.repeat(500))).summary.length, 300);
  const ok = saveTeam(home, REPO, team('good'));
  fs.writeFileSync(path.join(teamDir(home, ['core', 'live']), '2000-bad.json'), '{nope');
  const ids = listTeams(home, REPO, ['core', 'live']).map((t) => t.id);
  assert.ok(ids.includes(ok.id));
  assert.equal(ids.length, 2);
});
