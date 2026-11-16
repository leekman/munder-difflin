'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');

const loadTs = require('./load-ts.cjs');
const { teardownPlan } = loadTs('src/main/ptyTeardown.ts');

test('teardownPlan: a park keeps the worktree and never archives the card', () => {
  assert.deepEqual(teardownPlan({ hasWorktree: true, isWorker: false, keepWorktree: true }), { worktree: 'keep', archiveCard: false });
  assert.deepEqual(teardownPlan({ hasWorktree: true, isWorker: true, keepWorktree: true }), { worktree: 'keep', archiveCard: false });
  assert.deepEqual(teardownPlan({ hasWorktree: false, isWorker: true, keepWorktree: true }), { worktree: 'none', archiveCard: false });
});

test('teardownPlan: a kill removes the worktree (gated for a worker) and archives a worker card', () => {
  assert.deepEqual(teardownPlan({ hasWorktree: true, isWorker: false, keepWorktree: false }), { worktree: 'remove', archiveCard: false });
  assert.deepEqual(teardownPlan({ hasWorktree: true, isWorker: true, keepWorktree: false }), { worktree: 'gated', archiveCard: true });
  assert.deepEqual(teardownPlan({ hasWorktree: false, isWorker: false, keepWorktree: false }), { worktree: 'none', archiveCard: false });
});

test('pty:park tears down with keepWorktree and teardownPty follows teardownPlan', () => {
  const src = readFileSync('src/main/index.ts', 'utf8');
  const park = src.slice(src.indexOf("ipcMain.handle('pty:park'"), src.indexOf("ipcMain.handle('pty:list'"));
  assert.match(park, /teardownPty\(id, \{ keepWorktree: true \}\)/);
  const fn = src.slice(src.indexOf('function teardownPty('), src.indexOf('function teardownPty(') + 4000);
  assert.match(fn, /teardownPlan\(\{/);
});
