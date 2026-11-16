'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadTs = require('./load-ts.cjs');
const { restoreCwd } = loadTs('src/renderer/src/store/respawn.ts');

test('restoreCwd: worktree vivant + workdir -> sous-dossier du worktree', () => {
  assert.deepEqual(
    restoreCwd({ cwd: '/repo', worktreePath: '/wt/a', workdir: 'packages/x' }, true, '/repo'),
    { cwd: '/wt/a/packages/x' }
  );
});

test('restoreCwd: worktree vivant sans workdir -> racine du worktree', () => {
  assert.deepEqual(restoreCwd({ cwd: '/repo', worktreePath: '/wt/a' }, true, '/repo'), { cwd: '/wt/a' });
});

test('restoreCwd: ancien agent sans workdir dont le cwd est dans le worktree -> cwd conserve', () => {
  assert.deepEqual(
    restoreCwd({ cwd: '/wt/a/packages/x', worktreePath: '/wt/a' }, true, '/repo'),
    { cwd: '/wt/a/packages/x' }
  );
});

test('restoreCwd: worktree mort -> a.cwd avec worktree-gone', () => {
  assert.deepEqual(
    restoreCwd({ cwd: '/repo/packages/x', worktreePath: '/wt/a', workdir: 'packages/x' }, false, '/repo'),
    { cwd: '/repo/packages/x', note: 'worktree-gone' }
  );
});

test('restoreCwd: pas de worktree -> a.cwd', () => {
  assert.deepEqual(restoreCwd({ cwd: '/repo/apps/web' }, false, '/repo'), { cwd: '/repo/apps/web' });
});

const { resolveRestoreCwd } = loadTs('src/renderer/src/store/respawn.ts');
const probes = (repo, dirs) => ({ isRepo: async () => repo, isDir: async (p) => dirs.includes(p) });

test('resolveRestoreCwd: sous-dossier present -> inchange', async () => {
  const r = await resolveRestoreCwd({ cwd: '/repo', worktreePath: '/wt', workdir: 'p/x' }, '/repo', probes(true, ['/wt/p/x']));
  assert.deepEqual(r, { cwd: '/wt/p/x', note: undefined, worktreeAlive: true, subGone: false });
});

test('resolveRestoreCwd: sous-dossier disparu, worktree vivant -> racine du worktree', async () => {
  const r = await resolveRestoreCwd({ cwd: '/repo', worktreePath: '/wt', workdir: 'p/x' }, '/repo', probes(true, []));
  assert.equal(r.cwd, '/wt');
  assert.equal(r.note, 'workdir-gone');
  assert.equal(r.subGone, true);
});

test('resolveRestoreCwd: worktree mort + sous-dossier disparu -> floorRepo, garde worktree-gone', async () => {
  const r = await resolveRestoreCwd({ cwd: '/repo/p/x', worktreePath: '/wt', workdir: 'p/x' }, '/repo', probes(false, []));
  assert.equal(r.cwd, '/repo');
  assert.equal(r.note, 'worktree-gone');
  assert.equal(r.subGone, true);
});

test('resolveRestoreCwd: sans worktree, workdir disparu -> floorRepo', async () => {
  const r = await resolveRestoreCwd({ cwd: '/repo/p/x', workdir: 'p/x' }, '/repo', probes(false, []));
  assert.deepEqual([r.cwd, r.note], ['/repo', 'workdir-gone']);
});

test('resolveRestoreCwd: cwd du premier lancement dans le worktree et present -> prefere a workdir', async () => {
  const r = await resolveRestoreCwd(
    { cwd: '/wt/apps/web', worktreePath: '/wt', workdir: 'p/x' }, '/repo', probes(true, ['/wt/apps/web', '/wt/p/x'])
  );
  assert.deepEqual(r, { cwd: '/wt/apps/web', note: undefined, worktreeAlive: true, subGone: false });
});

test('resolveRestoreCwd: cwd dans le worktree mais disparu -> repli sur workdir', async () => {
  const r = await resolveRestoreCwd(
    { cwd: '/wt/apps/web', worktreePath: '/wt', workdir: 'p/x' }, '/repo', probes(true, ['/wt/p/x'])
  );
  assert.deepEqual(r, { cwd: '/wt/p/x', note: undefined, worktreeAlive: true, subGone: false });
});
