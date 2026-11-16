'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { worktreeCwd, resolveProjectInfo } = loadTs('src/main/projectInfo.ts');
const { mainRepoRoot, addWorktree } = loadTs('src/main/git.ts');

test('worktreeCwd keeps the sub-folder inside the worktree', () => {
  assert.equal(worktreeCwd('/h/wt/a1', '/r', '/r/packages/x'), path.join('/h/wt/a1', 'packages', 'x'));
});

test('worktreeCwd falls back to the worktree root at the repo root or outside it', () => {
  assert.equal(worktreeCwd('/h/wt/a1', '/r', '/r'), '/h/wt/a1');
  assert.equal(worktreeCwd('/h/wt/a1', '/r', '/elsewhere'), '/h/wt/a1');
  assert.equal(worktreeCwd('/h/wt/a1', '/r', '/r2/x'), '/h/wt/a1');
});

test('a worktree made from a sub-folder starts in the same sub-folder', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-wt-sub-')));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t.t');
  g(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'packages', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'x', 'a.txt'), 'a');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  const orig = path.join(repo, 'packages', 'x');
  const root = await mainRepoRoot(orig);
  assert.equal(root, repo);
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-wt-out-'))), 'a1');
  assert.equal((await addWorktree(root, wt, 'main')).ok, true);
  const cwd = worktreeCwd(wt, root, orig);
  assert.equal(cwd, path.join(wt, 'packages', 'x'));
  assert.ok(fs.existsSync(path.join(cwd, 'a.txt')));
  const info = await resolveProjectInfo(cwd);
  assert.equal(info.repoRoot, repo);
  assert.equal(info.isolated, true);
  assert.equal(info.subdir, 'packages/x');
});
