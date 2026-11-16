const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { detectSubprojects, rootHasManifest } = loadTs('src/main/subprojects.ts');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subprojects-'));
  for (const f of files) {
    const abs = path.join(root, f);
    if (f.endsWith('/')) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '{}');
  }
  return root;
}
const noIgnore = async () => new Set();

test('detects manifest dirs and keeps the shallowest', async () => {
  const root = tree([
    'packages/services/live/composer.json', 'packages/services/core/package.json',
    'packages/ax/package.json', 'packages/ax/tooling/package.json'
  ]);
  const { items, truncated } = await detectSubprojects(root, { ignored: noIgnore });
  assert.deepEqual(items.map(i => i.path), ['packages/ax', 'packages/services/core', 'packages/services/live']);
  assert.equal(truncated, false);
  const live = items.find(i => i.label === 'live');
  assert.equal(live.group, 'packages/services');
  assert.deepEqual(live.kinds, ['composer']);
});

test('fallback lists manifest-less siblings inside a group', async () => {
  const root = tree([
    'packages/services/live/composer.json', 'packages/services/live/poc/',
    'packages/services/core/package.json', 'packages/services/ai-kev/README.md'
  ]);
  const { items } = await detectSubprojects(root, { ignored: noIgnore });
  const paths = items.map(i => i.path);
  assert.ok(paths.includes('packages/services/ai-kev'));
  assert.deepEqual(items.find(i => i.label === 'ai-kev').kinds, []);
  assert.ok(!paths.includes('packages/services/live/poc'));
  assert.ok(!paths.includes('packages/services'), 'a group is not listed as its own sibling');
});

test('ignores hidden, node_modules, vendor and isIgnored', async () => {
  const root = tree(['node_modules/x/package.json', '.cache/y/package.json', 'vendor/v/package.json', 'tmp/z/package.json']);
  const { items } = await detectSubprojects(root, { ignored: async rels => new Set(rels.filter(rel => rel === 'tmp/z' || rel === 'tmp')) });
  assert.deepEqual(items, []);
});

test('respects maxDepth and max', async () => {
  const root = tree(['a/package.json', 'b/package.json', 'c/package.json', 'd/e/f/g/h/package.json']);
  const r = await detectSubprojects(root, { max: 2, ignored: noIgnore });
  assert.equal(r.items.length, 2);
  assert.equal(r.truncated, true);
  const deep = await detectSubprojects(root, { maxDepth: 4, ignored: noIgnore });
  assert.ok(!deep.items.some(i => i.path.startsWith('d/')));
});

test('rootHasManifest', () => {
  assert.equal(rootHasManifest(tree(['package.json'])), true);
  assert.equal(rootHasManifest(tree(['src/a.ts'])), false);
});

const { resolveWorkdir } = loadTs('src/main/subprojects.ts');

test('resolveWorkdir: a relative sub-folder inside the repo -> its absolute path', async () => {
  const root = tree(['apps/web/package.json', 'notes.txt']);
  assert.equal(await resolveWorkdir(root, 'apps/web'), path.join(root, 'apps/web'));
  assert.equal(await resolveWorkdir(root, 'apps/web/'), path.join(root, 'apps/web'));
});

test('resolveWorkdir: unsafe, missing, file or too long -> null', async () => {
  const root = tree(['apps/web/package.json', 'notes.txt']);
  for (const rel of ['', '../x', 'apps/../..', '/etc', 'apps\\web', 'nope', 'notes.txt', 'a'.repeat(201), 42, null]) {
    assert.equal(await resolveWorkdir(root, rel), null, String(rel));
  }
});

test('resolveWorkdir: a symlink pointing outside the repo -> null', async () => {
  const root = tree(['apps/web/package.json']);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'apps/escape'));
  assert.equal(await resolveWorkdir(root, 'apps/escape'), null);
  // A symlink that stays inside the repo is fine.
  fs.symlinkSync(path.join(root, 'apps/web'), path.join(root, 'apps/alias'));
  assert.equal(await resolveWorkdir(root, 'apps/alias'), path.join(root, 'apps/alias'));
});
