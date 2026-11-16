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
