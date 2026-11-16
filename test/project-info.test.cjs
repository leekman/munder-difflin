'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { resolveProjectInfo, projectBlock } = loadTs('src/main/projectInfo.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeRepo() {
  const dir = tmp('md-proj-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('a direct checkout is not isolated', async () => {
  const repo = makeRepo();
  const info = await resolveProjectInfo(repo);
  assert.equal(info.isGit, true);
  assert.equal(info.isolated, false);
  assert.equal(fs.realpathSync(info.repoRoot), repo);
  assert.equal(info.branch, 'main');
  assert.equal(info.worktreePath, undefined);
});

test('a linked worktree is isolated and points at the main repo', async () => {
  const repo = makeRepo();
  const wt = path.join(tmp('md-proj-wt-'), 'x');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/x', wt);
  const info = await resolveProjectInfo(wt, { baseBranch: 'main' });
  assert.equal(info.isolated, true);
  assert.equal(fs.realpathSync(info.repoRoot), repo);
  assert.equal(fs.realpathSync(info.worktreePath), fs.realpathSync(wt));
  assert.equal(info.branch, 'agent/x');
  assert.equal(info.baseBranch, 'main');
});

test('a plain folder is not git', async () => {
  const dir = tmp('md-proj-plain-');
  const info = await resolveProjectInfo(dir);
  assert.equal(info.isGit, false);
  assert.equal(info.isolated, false);
  assert.equal(fs.realpathSync(info.repoRoot), dir);
});

test('projectBlock renders the exact texts', () => {
  assert.equal(
    projectBlock({ repoRoot: '/r/app', isGit: true, isolated: false, branch: 'main' }),
    'Projet : `app` (`/r/app`). Tu travailles directement dans ce repo, branche `main`. D\'autres agents peuvent travailler dans le même arbre.'
  );
  assert.equal(
    projectBlock({ repoRoot: '/r/app', isGit: true, isolated: true, worktreePath: '/w/a1', branch: 'agent/a1', baseBranch: 'dev' }),
    'Projet : `app` (`/r/app`). Tu travailles dans un worktree isolé `/w/a1`, branche `agent/a1` créée depuis `dev`. Tes changements n\'arrivent dans le repo qu\'une fois mergés.'
  );
  assert.equal(
    projectBlock({ repoRoot: '/r/app', isGit: true, isolated: true, worktreePath: '/w/a1', branch: 'agent/a1' }),
    'Projet : `app` (`/r/app`). Tu travailles dans un worktree isolé `/w/a1`, branche `agent/a1`. Tes changements n\'arrivent dans le repo qu\'une fois mergés.'
  );
  assert.equal(projectBlock({ repoRoot: '/r/plain', isGit: false, isolated: false }), 'Projet : `/r/plain`.');
});

test('identity.md carries the project block', async () => {
  const home = tmp('md-proj-home-');
  const hive = new HiveManager(() => home);
  const base = { name: 'A', provider: 'claude', cwd: home };
  await hive.ensureAgent({ ...base, id: 'a1', project: { repoRoot: home, isGit: false, isolated: false } });
  await hive.ensureAgent({ ...base, id: 'a2' });
  const read = (id) => {
    const root = path.join(home, 'hive');
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'identity.md' && p.includes(id)) found.push(fs.readFileSync(p, 'utf8'));
      }
    })(root);
    return found.join('\n');
  };
  assert.match(read('a1'), /Projet :/);
  assert.doesNotMatch(read('a2'), /Projet :/);
});

test('a sub-folder of a checkout reports its subdir and the block names it', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'packages', 'x'), { recursive: true });
  const info = await resolveProjectInfo(path.join(repo, 'packages', 'x'));
  assert.equal(info.subdir, 'packages/x');
  assert.equal(info.isolated, false);
  assert.ok(projectBlock(info).includes('Sous-projet : `packages/x`'));
  const root = await resolveProjectInfo(repo);
  assert.equal(root.subdir, undefined);
  assert.ok(!projectBlock(root).includes('Sous-projet'));
});
