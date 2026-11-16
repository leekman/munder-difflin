'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loadTs = require('./load-ts.cjs');
const { runTeamAnalysis, writeTeamHires, sanitizeTeamInput } = loadTs('src/main/teamComposer.ts');
const { repoSlug } = loadTs('src/main/roster.ts');

const input = { repoRoot: '/work/my-repo', existingAgents: [], round: 1 };
const validAgents = JSON.stringify({ kind: 'agents', agents: [{ manifest: { spec: 'munder-difflin/hire@1', name: 'Jim' }, why: 'x' }] });

test('a valid first answer needs no retry', async () => {
  let calls = 0;
  const r = await runTeamAnalysis(input, async () => { calls++; return { ok: true, text: validAgents }; });
  assert.equal(calls, 1);
  assert.equal(r.kind, 'agents');
});

test('invalid JSON is retried once then reported', async () => {
  const prompts = [];
  const r = await runTeamAnalysis(input, async (p) => { prompts.push(p); return { ok: true, text: 'not json at all' }; });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes("Ta réponse précédente n'était pas un JSON valide"));
  assert.equal(r.kind, 'error');
  assert.ok(r.error);
});

test('a failed run is reported as an error', async () => {
  const r = await runTeamAnalysis(input, async () => ({ ok: false, error: 'cancelled' }));
  assert.equal(r.kind, 'error');
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'team-')); }
const m = (name) => ({ spec: 'munder-difflin/hire@1', name });

test('writeTeamHires writes one file per manifest under hires/<slug>', () => {
  const home = tmp();
  const repo = '/work/my-repo';
  const r = writeTeamHires(home, repo, [m('Jim'), m('Pam')], new Date('2026-11-09T10:00:00Z'));
  const dir = path.join(home, 'hires', repoSlug(repo));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.written.map((f) => path.basename(f)).sort(), ['2026-11-09-jim.json', '2026-11-09-pam.json']);
  for (const f of r.written) assert.equal(path.dirname(f), dir);
  assert.equal(JSON.parse(fs.readFileSync(r.written[0], 'utf8')).name, 'Jim');
});

test('does not overwrite on name collision', () => {
  const home = tmp();
  const r = writeTeamHires(home, '/work/r', [m('Jim'), m('Jim')], new Date('2026-11-09T10:00:00Z'));
  assert.deepEqual(r.written.map((f) => path.basename(f)), ['2026-11-09-jim.json', '2026-11-09-jim-2.json']);
  const again = writeTeamHires(home, '/work/r', [m('Jim')], new Date('2026-11-09T10:00:00Z'));
  assert.equal(path.basename(again.written[0]), '2026-11-09-jim-3.json');
});

test('writeTeamHires rejects a manifest that fails validation', () => {
  const home = tmp();
  const r = writeTeamHires(home, '/work/r', [{ spec: 'munder-difflin/hire@1', name: 'x'.repeat(41) }, m('Jim')]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.written.length, 1);
});

test('writeTeamHires returns the manifests actually written, in order', () => {
  const home = tmp();
  const r = writeTeamHires(home, '/work/r', [m('Jim'), { spec: 'munder-difflin/hire@1', name: 'x'.repeat(41) }, m('Pam')]);
  assert.deepEqual(r.manifests.map((x) => x.name), ['Jim', 'Pam']);
  assert.equal(r.manifests.length, r.written.length);
});

test('a hostile name cannot escape the hires directory', () => {
  const home = tmp();
  const r = writeTeamHires(home, '/work/r', [m('../../evil/..')], new Date('2026-11-09T10:00:00Z'));
  const dir = path.join(home, 'hires', repoSlug('/work/r'));
  for (const f of r.written) assert.equal(path.dirname(f), dir);
  assert.equal(r.written.length, 1);
});

test('runHiddenClaude honours an abort signal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/hiddenClaude.ts'), 'utf8');
  assert.match(src, /signal\?: AbortSignal/);
  assert.match(src, /signal\?\.addEventListener\('abort'/);
  assert.match(src, /error: 'cancelled'/);
  assert.match(src, /opts\.signal\?\.aborted/);
});

test('sanitizeTeamInput caps every renderer-supplied field', () => {
  const { sanitizeTeamInput, TEAM_INPUT_CAPS: C } = loadTs('src/main/teamComposer.ts');
  assert.deepEqual(C, { existingAgents: 50, answers: 3, answerChars: 2000, analysisChars: 6000, manifests: 12, scope: 40 });
  const raw = {
    repoRoot: '/evil',
    round: 2,
    analysis: 'a'.repeat(7000),
    existingAgents: Array.from({ length: 60 }, (_, i) => ({ name: `n${i}`, description: 'd'.repeat(500) })),
    answers: Array.from({ length: 5 }, () => ({ question: 'q'.repeat(3000), answer: 'r'.repeat(3000) })),
  };
  const out = sanitizeTeamInput(raw, '/bound', 'model-x');
  assert.equal(out.repoRoot, '/bound', 'the bound repo wins over the renderer path');
  assert.equal(out.round, 2);
  assert.equal(out.defaultModel, 'model-x');
  assert.equal(out.analysis.length, 6000);
  assert.equal(out.existingAgents.length, 50);
  assert.ok(out.existingAgents[0].description.length <= 200);
  assert.equal(out.answers.length, 3);
  for (const a of out.answers) {
    assert.equal(a.answer.length, 2000);
    assert.ok(a.question.length <= 2000);
  }
});

test('sanitizeTeamInput rejects non-objects', () => {
  const { sanitizeTeamInput } = loadTs('src/main/teamComposer.ts');
  assert.equal(sanitizeTeamInput(null, '/r'), null);
  assert.equal(sanitizeTeamInput('x', '/r'), null);
});

test('sanitizeTeamInput keeps model ids for known providers only, id-shaped and capped', () => {
  const input = sanitizeTeamInput({
    round: 1,
    models: {
      claude: ['claude-opus-5-5', 'bad;rm -rf', 42, ...Array(40).fill('m')],
      custom: ['x'],
      codex: 'not-a-list'
    }
  }, '/work/repo');
  assert.deepEqual(Object.keys(input.models), ['claude']);
  assert.equal(input.models.claude[0], 'claude-opus-5-5');
  assert.ok(!input.models.claude.includes('bad;rm -rf'));
  assert.equal(input.models.claude.length, 24);
  assert.equal(sanitizeTeamInput({ round: 1 }, '/work/repo').models, undefined);
});

test('runAgentDraft keeps the first agent and rejects an empty or questions answer', async () => {
  const { runAgentDraft, sanitizeAgentDraftInput } = loadTs('src/main/teamComposer.ts');
  const draft = { repoRoot: '/r', request: 'qa', existingAgents: [] };
  const two = JSON.stringify({ agents: [{ spec: 'munder-difflin/hire@1', name: 'A', why: 'w' }, { spec: 'munder-difflin/hire@1', name: 'B' }] });
  const r = await runAgentDraft(draft, async () => ({ ok: true, text: two }));
  assert.equal(r.kind, 'agents');
  assert.equal(r.agents.length, 1);
  assert.equal(r.agents[0].manifest.name, 'A');
  const none = await runAgentDraft(draft, async () => ({ ok: true, text: '{"agents": []}' }));
  assert.equal(none.kind, 'error');
  const q = await runAgentDraft(draft, async () => ({ ok: true, text: '{"analysis": "a", "questions": ["?"]}' }));
  assert.equal(q.kind, 'error');

  assert.equal(sanitizeAgentDraftInput({ request: '   ' }, '/r'), null);
  const s = sanitizeAgentDraftInput({ request: 'x'.repeat(5000), existingAgents: [{ name: 'Jim' }], repoRoot: '/evil' }, null);
  assert.equal(s.request.length, 2000);
  assert.equal(s.repoRoot, null);
  assert.deepEqual(s.existingAgents.map((a) => a.name), ['Jim']);
});

test('sanitizeTeamInput filters scope', () => {
  const { sanitizeTeamInput, TEAM_INPUT_CAPS: C } = loadTs('src/main/teamComposer.ts');
  const raw = { round: 1, scope: ['packages/b', '../x', 'packages/a', 'packages/a', 'zzz'] };
  const allowed = new Set(['packages/a', 'packages/b']);
  assert.deepEqual(sanitizeTeamInput(raw, '/r', undefined, allowed).scope, ['packages/a', 'packages/b']);
  // without an allow-list only the path-safety filter applies
  assert.deepEqual(sanitizeTeamInput(raw, '/r').scope, ['packages/a', 'packages/b', 'zzz']);
  assert.equal(sanitizeTeamInput({ round: 1 }, '/r').scope, undefined);
  assert.equal(C.scope, 40);
  const many = Array.from({ length: 60 }, (_, i) => `p/${String(i).padStart(2, '0')}`);
  assert.equal(sanitizeTeamInput({ scope: many }, '/r', undefined, new Set(many)).scope.length, 40);
});
