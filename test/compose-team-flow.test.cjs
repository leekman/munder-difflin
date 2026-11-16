'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadTs = require('./load-ts.cjs');
const { nextStep, existingAgentsOf, cardsFromResponse, prepareWrite, shouldHighlightCompose } =
  loadTs('src/renderer/src/components/composeTeamFlow.ts');

const SPEC = 'munder-difflin/hire@1';

test('nextStep: questions → questions', () => {
  assert.equal(nextStep('analyzing', { kind: 'questions', analysis: 'a', questions: ['q?'] }), 'questions');
});

test('nextStep: agents → proposal', () => {
  assert.equal(nextStep('analyzing', { kind: 'agents', agents: [], invalid: [] }), 'proposal');
});

test('nextStep: error → error', () => {
  assert.equal(nextStep('analyzing', { kind: 'error', error: 'boom' }), 'error');
});

test('existing agents exclude god and system assistants', () => {
  const agents = [
    { name: 'Michael', description: 'boss', isGod: true },
    { name: 'Helper', description: 'system', isAssistant: true },
    { name: 'Jim', description: 'sales' },
    { name: 'Pam', description: '' }
  ];
  assert.deepEqual(existingAgentsOf(agents), [
    { name: 'Jim', description: 'sales' },
    { name: 'Pam', description: '' }
  ]);
});

test('cards: valid agents checked, invalid ones unchecked with their errors', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [{ manifest: { spec: SPEC, name: 'Jim', description: 'd' }, why: 'because' }],
    invalid: [{ name: 'Bad', errors: ['"goal" exceeds 4000 chars'] }]
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].checked, true);
  assert.equal(cards[0].manifest.name, 'Jim');
  assert.equal(cards[0].why, 'because');
  assert.equal(cards[1].checked, false);
  assert.equal(cards[1].invalid, true);
  assert.deepEqual(cards[1].errors, ['"goal" exceeds 4000 chars']);
});

test('prepareWrite revalidates checked cards and drops the failing ones', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [
      { manifest: { spec: SPEC, name: 'Jim' }, why: '' },
      { manifest: { spec: SPEC, name: 'Pam' }, why: '' },
      { manifest: { spec: SPEC, name: 'Dwight' }, why: '' }
    ],
    invalid: []
  });
  cards[1].manifest = { ...cards[1].manifest, name: 'x'.repeat(41) };
  cards[2].checked = false;
  const r = prepareWrite(cards);
  assert.deepEqual(r.manifests.map((m) => m.name), ['Jim']);
  assert.equal(r.cardErrors[0].length, 0);
  assert.ok(r.cardErrors[1].length > 0);
  assert.equal(r.cardErrors[2].length, 0);
});

test('compose is highlighted on a god-only floor', () => {
  assert.equal(shouldHighlightCompose([{ name: 'Michael', isGod: true }]), true);
  assert.equal(shouldHighlightCompose([]), true);
  assert.equal(shouldHighlightCompose([{ name: 'Michael', isGod: true }, { name: 'Helper', isAssistant: true }]), true);
});

test('compose is not highlighted once a worker exists', () => {
  assert.equal(shouldHighlightCompose([{ name: 'Michael', isGod: true }, { name: 'Jim' }]), false);
});

test('modelIdsByProvider lists catalog ids per hire provider, skipping the default entry', () => {
  const { modelIdsByProvider } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  const out = modelIdsByProvider((p) => p === 'claude'
    ? [{ label: 'Default' }, { id: 'claude-opus-5-5' }]
    : p === 'codex' ? [{ id: 'gpt-5.6-sol' }] : []);
  assert.deepEqual(out, { claude: ['claude-opus-5-5'], codex: ['gpt-5.6-sol'] });
});

// ── Périmètre monorepo (Task 9) ─────────────────────────────────────────────

const ITEMS = [
  { path: 'packages/a', label: 'a-app', group: 'packages', kinds: ['package.json'] },
  { path: 'packages/b', label: 'b-lib', group: 'packages', kinds: ['package.json'] },
  { path: 'apps/web', label: 'web', group: 'apps', kinds: ['package.json'] }
];

test('workdirOptions: racine first, then the scope sub-projects with their labels', () => {
  const { workdirOptions } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  assert.deepEqual(workdirOptions(['packages/a', 'packages/b'], ITEMS), [
    { value: '', label: 'racine' },
    { value: 'packages/a', label: 'a-app' },
    { value: 'packages/b', label: 'b-lib' }
  ]);
  // A path missing from the detection falls back to the path itself.
  assert.deepEqual(workdirOptions(['gone/x'], ITEMS).map((o) => o.label), ['racine', 'gone/x']);
});

test('cardsFromResponse keeps the manifest workdir', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [{ manifest: { spec: SPEC, name: 'Jim', workdir: 'packages/a' }, why: '' }],
    invalid: []
  });
  assert.equal(cards[0].manifest.workdir, 'packages/a');
});

test('cardsFromResponse with a scope: an out-of-scope workdir starts at racine', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [
      { manifest: { spec: SPEC, name: 'Jim', workdir: 'packages/a' }, why: '' },
      { manifest: { spec: SPEC, name: 'Pam', workdir: 'apps/web' }, why: '' }
    ],
    invalid: []
  }, ['packages/a', 'packages/b']);
  assert.equal(cards[0].manifest.workdir, 'packages/a');
  assert.equal('workdir' in cards[1].manifest, false);
});

test('prepareWrite passes workdir through', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [{ manifest: { spec: SPEC, name: 'Jim', workdir: 'packages/b' }, why: '' }],
    invalid: []
  });
  assert.equal(prepareWrite(cards).manifests[0].workdir, 'packages/b');
  assert.equal(prepareWrite(cards, ['packages/b']).manifests[0].workdir, 'packages/b');
});

test('prepareWrite with a scope replaces an out-of-scope workdir by racine', () => {
  const cards = cardsFromResponse({
    kind: 'agents',
    agents: [{ manifest: { spec: SPEC, name: 'Jim', workdir: 'apps/web' }, why: '' }],
    invalid: []
  });
  const r = prepareWrite(cards, ['packages/a']);
  assert.equal(r.manifests.length, 1);
  // validateHireManifest always lists the key; undefined = absent once serialised.
  assert.equal(r.manifests[0].workdir, undefined);
  assert.equal(r.cardErrors[0].length, 0);
});

test('analysisScope: whole repo when the monorepo mode is off or the scope is empty', () => {
  const { analysisScope } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  assert.deepEqual(analysisScope(null, ITEMS), { ok: true, scope: [] });
  assert.deepEqual(analysisScope({ enabled: false, scope: ['packages/a'] }, ITEMS), { ok: true, scope: [] });
  assert.deepEqual(analysisScope({ enabled: true, scope: [] }, ITEMS), { ok: true, scope: [] });
});

test('analysisScope: drops the missing paths, refuses when none is left', () => {
  const { analysisScope } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  assert.deepEqual(analysisScope({ enabled: true, scope: ['packages/a', 'gone/x'] }, ITEMS), { ok: true, scope: ['packages/a'] });
  const none = analysisScope({ enabled: true, scope: ['gone/x', 'gone/y'] }, ITEMS);
  assert.equal(none.ok, false);
  assert.equal(none.error, "Aucun sous-projet du périmètre n'existe plus — change le périmètre.");
});

test('workdirOf: relative path from the floor repo, only strictly inside it', () => {
  const { workdirOf } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  assert.equal(workdirOf('/r/mono', '/r/mono/packages/a'), 'packages/a');
  assert.equal(workdirOf('/r/mono/', '/r/mono/packages/a/'), 'packages/a');
  assert.equal(workdirOf('/r/mono', '/r/mono'), undefined);
  assert.equal(workdirOf('/r/mono', '/r/monorepo/x'), undefined);
  assert.equal(workdirOf('/r/mono', '/r/other'), undefined);
  assert.equal(workdirOf('/r/mono', '/r/mono/../other'), undefined);
  assert.equal(workdirOf('/r/mono', 'packages/a'), undefined);
  assert.equal(workdirOf(null, '/r/mono/packages/a'), undefined);
  assert.equal(workdirOf('/r/mono', '/r/mono/' + 'x'.repeat(201)), undefined);
});

test('initialHireCwd: existing hire workdir, else single-scope sub-project, else repo', () => {
  const { initialHireCwd } = loadTs('src/renderer/src/components/composeTeamFlow.ts');
  assert.equal(initialHireCwd('/r/mono', 'apps/web', true, ['packages/a']), '/r/mono/apps/web');
  assert.equal(initialHireCwd('/r/mono', 'apps/web', false, ['packages/a']), '/r/mono/packages/a');
  assert.equal(initialHireCwd('/r/mono', undefined, false, ['packages/a']), '/r/mono/packages/a');
  assert.equal(initialHireCwd('/r/mono', undefined, false, ['packages/a', 'packages/b']), '/r/mono');
  assert.equal(initialHireCwd('/r/mono', undefined, false, []), '/r/mono');
});
