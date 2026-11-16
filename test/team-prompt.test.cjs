'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadTs = require('./load-ts.cjs');
const { validateHireManifest } = loadTs('src/shared/hire.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { buildTeamPrompt, parseTeamResponse } = loadTs('src/shared/teamPrompt.ts');

const base = { repoRoot: '/work/my-repo', existingAgents: [{ name: 'Dwight', description: 'Reviewer' }] };

test('HIRE_LIMITS drives the validator', () => {
  const r = validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'x'.repeat(41) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('"name" exceeds 40 chars'));
});

test('the prompt embeds every limit and allowlist', () => {
  const p = buildTeamPrompt({ ...base, round: 1 });
  assert.ok(p.includes('4000'));
  assert.ok(p.includes('--model'));
  assert.ok(p.includes('md-audit'));
  for (const e of MCP_CATALOG) assert.ok(p.includes(e.id), e.id);
  assert.ok(p.includes('/work/my-repo'));
  assert.ok(p.includes('Dwight'));
});

test('round 2 carries analysis and answers', () => {
  const p = buildTeamPrompt({
    ...base, round: 2, analysis: 'ANALYSE-XYZ',
    answers: [{ question: 'Q-ONE?', answer: 'A-ONE' }]
  });
  assert.ok(p.includes('ANALYSE-XYZ'));
  assert.ok(p.includes('Q-ONE?'));
  assert.ok(p.includes('A-ONE'));
});

test('parseTeamResponse reads JSON wrapped in prose and fences', () => {
  const body = { agents: [{ spec: 'munder-difflin/hire@1', name: 'Ann', why: 'because {x}' }] };
  const text = 'Voici:\n```json\n' + JSON.stringify(body) + '\n```\nVoilà.';
  const r = parseTeamResponse(text);
  assert.equal(r.kind, 'agents');
  assert.equal(r.agents.length, 1);
  assert.equal(r.agents[0].manifest.name, 'Ann');
  assert.equal(r.agents[0].why, 'because {x}');
  assert.equal('why' in r.agents[0].manifest, false);
});

test('parseTeamResponse caps questions at 3 and analysis at 6000', () => {
  const r = parseTeamResponse(JSON.stringify({ analysis: 'a'.repeat(7000), questions: ['1', '2', '3', '4', '5'] }));
  assert.equal(r.kind, 'questions');
  assert.equal(r.questions.length, 3);
  assert.equal(r.analysis.length, 6000);
});

test('parseTeamResponse keeps invalid agents apart', () => {
  const r = parseTeamResponse(JSON.stringify({ agents: [
    { spec: 'munder-difflin/hire@1', name: 'Good' },
    { spec: 'munder-difflin/hire@1', name: 'Bad', commandFlags: ['--dangerously-skip-permissions'] }
  ] }));
  assert.equal(r.kind, 'agents');
  assert.equal(r.agents.length, 1);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].name, 'Bad');
  assert.ok(r.invalid[0].errors.length > 0);
});

test('parseTeamResponse reports non-JSON as error', () => {
  assert.equal(parseTeamResponse('no json here').kind, 'error');
  assert.equal(parseTeamResponse('{"foo": 1}').kind, 'error');
});

test('the prompt asks for provider, model and effort per role, with the offered model ids', () => {
  const p = buildTeamPrompt({
    ...base, round: 1, defaultModel: 'claude-opus-5-5',
    models: { claude: ['claude-opus-5-5', 'claude-haiku-5-5'], codex: ['gpt-5.6-sol'] }
  });
  assert.match(p, /MODÈLE ET EFFORT PAR RÔLE/);
  assert.match(p, /"effort": parmi low, medium, high, xhigh, max/);
  assert.match(p, /codex : low, medium, high, xhigh/);
  assert.match(p, /- claude : claude-opus-5-5, claude-haiku-5-5/);
  assert.match(p, /- codex : gpt-5\.6-sol/);
  assert.match(p, /Modèle par défaut de l'utilisateur : claude-opus-5-5/);
});

test('an agent proposed with an effort keeps it; an unknown effort makes it invalid', () => {
  const r = parseTeamResponse(JSON.stringify({ agents: [
    { spec: 'munder-difflin/hire@1', name: 'Arch', provider: 'claude', model: 'claude-opus-5-5', effort: 'max', why: 'revue' },
    { spec: 'munder-difflin/hire@1', name: 'Bad', effort: 'turbo' }
  ] }));
  assert.equal(r.kind, 'agents');
  assert.equal(r.agents[0].manifest.effort, 'max');
  assert.equal(r.invalid[0].name, 'Bad');
});

test('the team prompt sizes the team to the project, mandates a QA/Reviewer and no default docs role', () => {
  const { TEAM_SIZE } = loadTs('src/shared/teamPrompt.ts');
  for (const round of [1, 2]) {
    const p = buildTeamPrompt({ ...base, round });
    assert.ok(!p.includes('2 à 5'), 'no more hard 2-5 cap');
    assert.ok(p.includes(`de ${TEAM_SIZE.min} à ${TEAM_SIZE.usual} agents en général`));
    assert.ok(p.includes(`jusqu'à ${TEAM_SIZE.max} agents maximum UNIQUEMENT si le dépôt le justifie`));
    assert.match(p, /OBLIGATOIRE : l'équipe contient un agent QA \/ Reviewer/);
    assert.match(p, /Pas de rôle documentation par défaut/);
  }
  assert.ok(TEAM_SIZE.usual > 5);
  assert.equal(TEAM_SIZE.max, 12);
});

test('the agent draft prompt carries the request, the repo, existing agents and the spec', () => {
  const { buildAgentDraftPrompt } = loadTs('src/shared/teamPrompt.ts');
  const p = buildAgentDraftPrompt({
    repoRoot: '/work/my-repo', request: 'relit mes migrations SQL',
    existingAgents: [{ name: 'Dwight' }], models: { claude: ['claude-opus-5-5'] }
  });
  assert.ok(p.includes('relit mes migrations SQL'));
  assert.ok(p.includes('/work/my-repo'));
  assert.ok(p.includes('Dwight'));
  assert.ok(p.includes('munder-difflin/hire@1'));
  assert.match(p, /- claude : claude-opus-5-5/);
  assert.match(p, /exactement UN agent/);
  const noRepo = buildAgentDraftPrompt({ repoRoot: null, request: 'x', existingAgents: [] });
  assert.ok(!noRepo.includes('LECTURE SEULE'));
});

const fs = require('node:fs');
const path = require('node:path');
const SUMMARY_FMT = '{"teamSummary": "<résumé de l\'équipe en une phrase, ≤ 300 caractères>", "agents": [';

test('buildTeamPrompt with scope lists each path and restricts analysis', () => {
  const p = buildTeamPrompt({ ...base, round: 1, scope: ['packages/a', 'apps/web'] });
  assert.ok(p.includes('Analyse UNIQUEMENT ces sous-projets'));
  assert.ok(p.includes('packages/a') && p.includes('apps/web'));
  assert.ok(p.includes('workdir'));
});

test('buildTeamPrompt without scope is unchanged (apart from the teamSummary format)', () => {
  const input = { repoRoot: '/work/repo', existingAgents: [{ name: 'Jim', description: 'QA' }], defaultModel: 'm1', models: { claude: ['a', 'b'] }, analysis: 'AN', answers: [{ question: 'Q', answer: 'R' }] };
  for (const round of [1, 2]) {
    const snap = fs.readFileSync(path.join(__dirname, 'fixtures', `team-prompt-noscope-r${round}.txt`), 'utf8');
    for (const scope of [undefined, []]) {
      const out = buildTeamPrompt({ ...input, round, scope }).split(SUMMARY_FMT).join('{"agents": [');
      assert.equal(out, snap);
    }
    assert.ok(!snap.includes('PÉRIMÈTRE'));
  }
});

test('the prompt asks for teamSummary in round 1 (agents form) and round 2', () => {
  for (const round of [1, 2]) {
    const p = buildTeamPrompt({ ...base, round });
    assert.ok(p.includes(SUMMARY_FMT), `round ${round}`);
  }
});

test('parseTeamResponse keeps teamSummary capped at 300; absent → undefined', () => {
  const mk = (extra) => JSON.stringify({ ...extra, agents: [{ spec: 'munder-difflin/hire@1', name: 'Jim', why: 'x' }] });
  const a = parseTeamResponse(mk({ teamSummary: '  ' + 'x'.repeat(400) + '  ' }));
  assert.equal(a.kind, 'agents');
  assert.equal(a.teamSummary.length, 300);
  assert.equal(parseTeamResponse(mk({})).teamSummary, undefined);
  assert.equal(parseTeamResponse(mk({ teamSummary: 42 })).teamSummary, undefined);
});
