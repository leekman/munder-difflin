'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadTs = require('./load-ts.cjs');
const {
  sameScope, scopeLabel, shouldPreEnable, splitMissing, planScopeSwitch, switchScope, localSummary,
  countOpenTasks, resumeSavedTeam
} = loadTs('src/renderer/src/components/scopeFlow.ts');

const ITEMS = [
  { path: 'packages/services/live', label: 'live', group: 'packages/services', kinds: ['package.json'] },
  { path: 'packages/services/core', label: 'core', group: 'packages/services', kinds: ['composer.json'] },
  { path: 'packages/sdk/php', label: 'php', group: 'packages/sdk', kinds: ['composer.json'] }
];

test('sameScope ignores order', () => {
  assert.equal(sameScope(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameScope([], []), true);
  assert.equal(sameScope(['a'], ['a', 'b']), false);
  assert.equal(sameScope(['a', 'c'], ['a', 'b']), false);
});

test('scopeLabel: whole repo, 1, 2, 3 items', () => {
  assert.equal(scopeLabel([], ITEMS), 'tout le repo');
  assert.equal(scopeLabel(['packages/services/live'], ITEMS), 'live');
  assert.equal(scopeLabel(['packages/services/live', 'packages/services/core'], ITEMS), 'live + core');
  assert.equal(scopeLabel(['packages/services/live', 'packages/services/core', 'packages/sdk/php'], ITEMS), 'live + core + 1');
});

test('scopeLabel falls back to the last path segment for an unknown path', () => {
  assert.equal(scopeLabel(['apps/gone'], ITEMS), 'gone');
});

test('shouldPreEnable: no root manifest and at least 2 sub-projects', () => {
  assert.equal(shouldPreEnable(false, 2), true);
  assert.equal(shouldPreEnable(true, 10), false);
  assert.equal(shouldPreEnable(false, 1), false);
});

test('splitMissing separates paths absent from items', () => {
  assert.deepEqual(
    splitMissing(['packages/services/live', 'apps/gone', 'packages/sdk/php'], ITEMS),
    { present: ['packages/services/live', 'packages/sdk/php'], missing: ['apps/gone'] }
  );
});

const agent = (id, extra = {}) => ({ id, name: id, description: `desc ${id}`, status: 'idle', ...extra });

test('planScopeSwitch excludes god and assistants, lists busy agents', () => {
  const plan = planScopeSwitch([
    agent('god', { isGod: true, status: 'working' }),
    agent('helper', { isAssistant: true }),
    agent('jim'),
    agent('pam', { status: 'working' }),
    agent('dwight', { status: 'thinking' })
  ]);
  assert.deepEqual(plan.toPark.map((a) => a.id), ['jim', 'pam', 'dwight']);
  assert.deepEqual(plan.busy.map((a) => a.id), ['pam', 'dwight']);
  assert.equal(plan.needsConfirm, true);
});

test('planScopeSwitch: no confirmation without workers', () => {
  const plan = planScopeSwitch([agent('god', { isGod: true })]);
  assert.deepEqual(plan.toPark, []);
  assert.equal(plan.needsConfirm, false);
});

function fakeDeps({ agents: list, ...over } = {}) {
  const calls = [];
  const agents = list ?? [
    agent('god', { isGod: true, ptyId: 'pty-god' }),
    agent('jim', { ptyId: 'pty-jim' }),
    agent('pam', { ptyId: 'pty-pam' }),
    agent('ghost') // no live PTY: parked from the store, no parkPty
  ];
  const deps = {
    agents: () => agents,
    queues: () => ({ jim: [{ id: 'q1', text: 'hello' }], god: [{ id: 'q2', text: 'boss' }] }),
    slim: (list) => list.map((a) => ({ ...a, slim: true })),
    parkPty: async (id) => { calls.push(`parkPty:${id}`); return { ok: true }; },
    // Like the store: hands back the current queues of the parked ids.
    parkAgents: (ids) => {
      calls.push(`parkAgents:${ids.join(',')}`);
      const q = deps.queues();
      return { parked: [], queues: Object.fromEntries(ids.filter((id) => q[id]).map((id) => [id, q[id]])) };
    },
    teamsSave: async (t) => { calls.push('teamsSave'); deps.saved = t; return { ok: true, team: { id: 'T1' } }; },
    teamsForget: async (scope, id) => { calls.push(`teamsForget:${id}`); return true; },
    scopeSet: async (s) => { calls.push('scopeSet'); deps.scope = s; return { ok: true }; },
    teamsList: async () => { calls.push('teamsList'); return [{ id: 'K1' }]; },
    ...over
  };
  return { deps, calls };
}

const FROM = { enabled: true, scope: ['packages/services/live'] };
const TO = { enabled: true, scope: ['packages/sdk/php'] };
const ALL = ['jim', 'pam', 'ghost'];

test('switchScope aborts without parking when save fails', async () => {
  const { deps, calls } = fakeDeps({
    teamsSave: async () => { calls.push('teamsSave'); return { ok: false, error: 'disk full' }; }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.deepEqual(r, { ok: false, error: 'disk full' });
  assert.deepEqual(calls, ['teamsSave']);
});

test('switchScope aborts when save throws', async () => {
  const { deps, calls } = fakeDeps({
    teamsSave: async () => { calls.push('teamsSave'); throw new Error('ipc gone'); }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.equal(r.ok, false);
  assert.match(r.error, /ipc gone/);
  assert.deepEqual(calls, ['teamsSave']);
});

test('switchScope saves before parking', async () => {
  const { deps, calls } = fakeDeps();
  const r = await switchScope(deps, FROM, TO, 'Front + back', ALL);
  assert.deepEqual(r, { ok: true, known: [{ id: 'K1' }], notParked: [] });
  assert.deepEqual(calls, ['teamsSave', 'parkPty:pty-jim', 'parkPty:pty-pam', 'parkAgents:jim,pam,ghost', 'scopeSet', 'teamsList']);
  assert.deepEqual(deps.saved.scope, FROM.scope);
  assert.equal(deps.saved.summary, 'Front + back');
  assert.deepEqual(deps.saved.agents.map((a) => a.id), ['jim', 'pam', 'ghost']);
  assert.equal(deps.saved.agents[0].slim, true);
  // Only the parked agents' queues travel with the team.
  assert.deepEqual(deps.saved.queues, { jim: [{ id: 'q1', text: 'hello' }] });
  assert.equal('id' in deps.saved, false);
  assert.deepEqual(deps.scope, TO);
});

test('switchScope reuses currentTeamId and falls back to a local summary', async () => {
  const { deps } = fakeDeps({ currentTeamId: 'T0' });
  await switchScope(deps, FROM, TO, '  ', ALL);
  assert.equal(deps.saved.id, 'T0');
  assert.equal(deps.saved.summary, '3 agents : jim — desc jim ; pam — desc pam ; ghost — desc ghost');
});

test('switchScope with no agents skips save', async () => {
  const { deps, calls } = fakeDeps({ agents: [agent('god', { isGod: true })] });
  const r = await switchScope(deps, FROM, TO, '', []);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['parkAgents:', 'scopeSet', 'teamsList']);
});

const savedTeam = (id, agents, queues = {}) => ({ id, scope: FROM.scope, summary: 'S', agents, queues });

test('switchScope with no agents forgets a never-launched current team (no saved agent)', async () => {
  const { deps, calls } = fakeDeps({
    agents: [agent('god', { isGod: true })], currentTeamId: 'T0', currentTeam: savedTeam('T0', [])
  });
  await switchScope(deps, FROM, TO, '', []);
  assert.deepEqual(calls, ['teamsForget:T0', 'parkAgents:', 'scopeSet', 'teamsList']);
});

test('switchScope never forgets a current team that has saved agents, even with no live worker', async () => {
  const { deps, calls } = fakeDeps({
    agents: [agent('god', { isGod: true })], currentTeamId: 'T0',
    currentTeam: savedTeam('T0', [{ id: 'jim', name: 'jim' }])
  });
  const r = await switchScope(deps, FROM, TO, '', []);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['parkAgents:', 'scopeSet', 'teamsList']);
});

test('switchScope never forgets a current team whose saved content is unknown', async () => {
  const { deps, calls } = fakeDeps({ agents: [agent('god', { isGod: true })], currentTeamId: 'T0' });
  await switchScope(deps, FROM, TO, '', []);
  assert.deepEqual(calls, ['parkAgents:', 'scopeSet', 'teamsList']);
});

test('switchScope keeps the saved agents (and queues) that are not on the floor', async () => {
  const { deps } = fakeDeps({
    currentTeamId: 'T0',
    currentTeam: savedTeam('T0',
      [{ id: 'jim', name: 'jim', old: true }, { id: 'kevin', name: 'kevin' }],
      { jim: [{ id: 'old' }], kevin: [{ id: 'qk' }] })
  });
  await switchScope(deps, FROM, TO, '', ALL);
  assert.equal(deps.saved.id, 'T0');
  // Live entries win; kevin (failed resume, not on the floor) is kept with his queue.
  assert.deepEqual(deps.saved.agents.map((a) => a.id), ['jim', 'pam', 'ghost', 'kevin']);
  assert.equal(deps.saved.agents[0].old, undefined);
  assert.deepEqual(deps.saved.queues, { jim: [{ id: 'q1', text: 'hello' }], kevin: [{ id: 'qk' }] });
});

test('switchScope: a partial park re-save keeps the saved agents not on the floor', async () => {
  const saves = [];
  const { deps } = fakeDeps({
    currentTeamId: 'T0',
    currentTeam: savedTeam('T0', [{ id: 'kevin', name: 'kevin' }], { kevin: [{ id: 'qk' }] }),
    parkPty: async (id) => (id === 'pty-pam' ? { ok: false, error: 'busy' } : { ok: true }),
    teamsSave: async (t) => { saves.push(t); return { ok: true, team: { id: 'T0' } }; }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.deepEqual(r.notParked, ['pam']);
  assert.deepEqual(saves[1].agents.map((a) => a.id), ['jim', 'ghost', 'kevin']);
  assert.deepEqual(saves[1].queues, { jim: [{ id: 'q1', text: 'hello' }], kevin: [{ id: 'qk' }] });
});

test('switchScope: a PTY already gone (« no pty ») counts as parked', async () => {
  const { deps, calls } = fakeDeps({
    parkPty: async (id) => { calls.push(`parkPty:${id}`); return id === 'pty-pam' ? { ok: false, error: 'no pty: pty-pam' } : { ok: true }; }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.deepEqual(r, { ok: true, known: [{ id: 'K1' }], notParked: [] });
  assert.ok(calls.includes('parkAgents:jim,pam,ghost'));
});

test('switchScope re-saves the team when the parked queues differ from the snapshot', async () => {
  const saves = [];
  let q = { jim: [{ id: 'q1' }] };
  const { deps, calls } = fakeDeps({
    queues: () => q,
    parkPty: async (id) => { calls.push(`parkPty:${id}`); q = { jim: [{ id: 'q1' }, { id: 'q-late' }] }; return { ok: true }; },
    teamsSave: async (t) => { calls.push('teamsSave'); saves.push(t); return { ok: true, team: { id: 'T1' } }; }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['teamsSave', 'parkPty:pty-jim', 'parkPty:pty-pam', 'parkAgents:jim,pam,ghost', 'teamsSave', 'scopeSet', 'teamsList']);
  assert.equal(saves[1].id, 'T1');
  assert.deepEqual(saves[1].agents.map((a) => a.id), ['jim', 'pam', 'ghost']);
  assert.deepEqual(saves[1].queues, { jim: [{ id: 'q1' }, { id: 'q-late' }] });
});

test('switchScope: scope written but the team list fails -> ok with no known team', async () => {
  const { deps, calls } = fakeDeps({ teamsList: async () => { calls.push('teamsList'); throw new Error('ipc'); } });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.deepEqual(r, { ok: true, known: [], notParked: [] });
});

test('switchScope: scopeSet failure after parking offers the just-saved team', async () => {
  const listed = [];
  const { deps } = fakeDeps({
    scopeSet: async () => ({ ok: false, error: 'bad scope' }),
    teamsList: async (scope) => { listed.push(scope); return [{ id: 'T1' }]; }
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.deepEqual(r, { ok: false, error: 'bad scope', known: [{ id: 'T1' }], notParked: [] });
  assert.deepEqual(listed, [FROM.scope]);
});

test('switchScope refuses when the team changed since the confirmation', async () => {
  const { deps, calls } = fakeDeps();
  const r = await switchScope(deps, FROM, TO, '', ['jim', 'pam']);
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.deepEqual(calls, []);
});

test('switchScope keeps on the floor an agent whose PTY could not be parked', async () => {
  const saves = [];
  const { deps, calls } = fakeDeps({
    parkPty: async (id) => { calls.push(`parkPty:${id}`); return id === 'pty-pam' ? { ok: false, error: 'no' } : { ok: true }; },
    teamsSave: async (t) => { calls.push('teamsSave'); saves.push(t); return { ok: true, team: { id: 'T1' } }; },
    queues: () => ({ jim: [{ id: 'q1' }], pam: [{ id: 'q2' }] })
  });
  const r = await switchScope(deps, FROM, TO, 'S', ALL);
  assert.deepEqual(r, { ok: true, known: [{ id: 'K1' }], notParked: ['pam'] });
  assert.deepEqual(calls, [
    'teamsSave', 'parkPty:pty-jim', 'parkPty:pty-pam', 'teamsSave', 'parkAgents:jim,ghost', 'scopeSet', 'teamsList'
  ]);
  // Re-saved under the same id without pam nor its queue.
  assert.equal(saves[1].id, 'T1');
  assert.deepEqual(saves[1].agents.map((a) => a.id), ['jim', 'ghost']);
  assert.deepEqual(saves[1].queues, { jim: [{ id: 'q1' }] });
});

test('switchScope: a throwing parkPty counts as not parked; nobody parked forgets a new team', async () => {
  const { deps, calls } = fakeDeps({
    agents: [agent('jim', { ptyId: 'pty-jim' })],
    parkPty: async (id) => { calls.push(`parkPty:${id}`); throw new Error('ipc'); }
  });
  const r = await switchScope(deps, FROM, TO, '', ['jim']);
  assert.deepEqual(r.notParked, ['jim']);
  assert.deepEqual(calls, ['teamsSave', 'parkPty:pty-jim', 'teamsForget:T1', 'parkAgents:', 'scopeSet', 'teamsList']);
});

test('localSummary lists agents and truncates to 300', () => {
  assert.equal(localSummary([{ name: 'Jim', description: 'sales' }]), '1 agent : Jim — sales');
  assert.equal(localSummary([{ name: 'Pam' }]), '1 agent : Pam');
  const long = localSummary(Array.from({ length: 30 }, (_, i) => ({ name: `Agent${i}`, description: 'x'.repeat(40) })));
  assert.equal(long.length, 300);
  assert.ok(long.startsWith('30 agents : Agent0'));
});

test('countOpenTasks counts non-done tasks assigned to the given agents', () => {
  const raw = { tasks: [
    { id: '1', status: 'doing', assignee: 'jim' },
    { id: '2', status: 'todo', assignee: 'pam' },
    { id: '3', status: 'done', assignee: 'jim' },
    { id: '4', status: 'blocked', assignee: 'god' },
    { id: '5', status: 'todo' },
    { id: '6', status: 'blocked', assignee: 'jim' },
    { id: '7', status: 'archived', assignee: 'jim' }
  ] };
  assert.equal(countOpenTasks(raw, ['jim', 'pam']), 3);
  assert.equal(countOpenTasks(null, ['jim']), 0);
  assert.equal(countOpenTasks({ tasks: 'nope' }, ['jim']), 0);
});

test('switchScope: scopeSet failure after a partial park still reports notParked', async () => {
  const { deps } = fakeDeps({
    parkPty: async (id) => (id === 'pty-pam' ? { ok: false } : { ok: true }),
    scopeSet: async () => ({ ok: false, error: 'bad scope' })
  });
  const r = await switchScope(deps, FROM, TO, '', ALL);
  assert.equal(r.ok, false);
  assert.deepEqual(r.notParked, ['pam']);
});

test('switchScope: nobody parked leaves a pre-existing current team untouched', async () => {
  const saves = [];
  const { deps, calls } = fakeDeps({
    agents: [agent('jim', { ptyId: 'pty-jim' })],
    currentTeamId: 'T0',
    parkPty: async (id) => { calls.push(`parkPty:${id}`); return { ok: false }; },
    teamsSave: async (t) => { calls.push('teamsSave'); saves.push(t); return { ok: true, team: { id: 'T0' } }; }
  });
  const r = await switchScope(deps, FROM, TO, '', ['jim']);
  assert.deepEqual(r.notParked, ['jim']);
  assert.deepEqual(calls, ['teamsSave', 'parkPty:pty-jim', 'parkAgents:', 'scopeSet', 'teamsList']);
  assert.equal(saves.length, 1);
});

function resumeDeps({ floor = [], respawn, ...over } = {}) {
  const calls = [];
  const onFloor = new Set(floor);
  const deps = {
    respawn: respawn ?? (async (e) => ({ agent: { id: e.id } })),
    isOnFloor: (id) => onFloor.has(id),
    addAgent: (a) => { calls.push(`add:${a.id}`); onFloor.add(a.id); },
    restoreQueues: (q) => { calls.push('restoreQueues'); deps.restored = q; },
    setCurrentTeam: (id) => calls.push(`current:${id}`),
    teamsTouch: async (scope, id) => { calls.push(`touch:${id}`); },
    teamsSave: async (t) => { calls.push('teamsSave'); deps.saved = t; return { ok: true, team: t }; },
    teamsList: async () => { calls.push('teamsList'); return [{ id: 'T0' }]; },
    setKnownTeams: (l) => { calls.push('known'); deps.known = l; },
    ...over
  };
  return { deps, calls };
}

const TEAM = {
  id: 'T0', scope: ['packages/services/live'], summary: 'S',
  agents: [{ id: 'jim', name: 'Jim' }, { id: 'pam', name: 'Pam' }, { id: 'kevin', name: 'Kevin' }],
  queues: { jim: [{ id: 'qj' }], pam: [{ id: 'qp' }], kevin: [{ id: 'qk' }] }
};

test('resumeSavedTeam gives back the queues of respawned agents and re-saves the team without them', async () => {
  const { deps, calls } = resumeDeps({
    respawn: async (e) => (e.id === 'kevin' ? { agent: null, error: 'spawn failed' } : { agent: { id: e.id } })
  });
  const notes = await resumeSavedTeam(deps, TEAM);
  assert.deepEqual(calls, ['add:jim', 'add:pam', 'restoreQueues', 'current:T0', 'touch:T0', 'teamsSave', 'teamsList', 'known']);
  assert.deepEqual(deps.restored, { jim: [{ id: 'qj' }], pam: [{ id: 'qp' }] });
  // Kevin failed: his entry and his queue stay in the file.
  assert.deepEqual(deps.saved.agents, TEAM.agents);
  assert.deepEqual(deps.saved.queues, { kevin: [{ id: 'qk' }] });
  assert.deepEqual(notes, ['non relancé — Kevin : spawn failed']);
});

test('resumeSavedTeam: « already exists » with the agent on the floor counts as present', async () => {
  const { deps, calls } = resumeDeps({
    floor: ['jim'],
    respawn: async (e) => (e.id === 'jim' ? { agent: null, error: 'pty pty-jim already exists' } : { agent: { id: e.id } })
  });
  const notes = await resumeSavedTeam(deps, { ...TEAM, agents: [TEAM.agents[0]], queues: { jim: [{ id: 'qj' }] } });
  assert.deepEqual(notes, []);
  assert.deepEqual(deps.restored, {});
  // Jim is on the floor: his queue leaves the file (his live queue is the store's).
  assert.deepEqual(calls, ['restoreQueues', 'current:T0', 'touch:T0', 'teamsSave', 'teamsList', 'known']);
  assert.deepEqual(deps.saved.queues, {});
});

test('resumeSavedTeam: « already exists » without the agent on the floor is a failure', async () => {
  const { deps, calls } = resumeDeps({
    respawn: async () => ({ agent: null, error: 'pty pty-jim already exists' })
  });
  const notes = await resumeSavedTeam(deps, { ...TEAM, agents: [TEAM.agents[0]], queues: { jim: [{ id: 'qj' }] } });
  assert.deepEqual(notes, ['non relancé — Jim : pty pty-jim already exists']);
  // Nobody back: the team is neither made current nor rewritten.
  assert.deepEqual(calls, ['restoreQueues']);
  assert.deepEqual(deps.restored, {});
});

test('resumeSavedTeam: no queue to clear -> no re-save; notes for fresh and gone folders', async () => {
  const { deps, calls } = resumeDeps({
    respawn: async (e) => ({ agent: { id: e.id }, fresh: true, note: e.id === 'jim' ? 'workdir-gone' : 'worktree-gone' })
  });
  const notes = await resumeSavedTeam(deps, { ...TEAM, agents: TEAM.agents.slice(0, 2), queues: {} });
  assert.ok(!calls.includes('teamsSave'));
  assert.deepEqual(notes, [
    '2 agents repartent sans historique',
    'sous-projet introuvable : démarré à la racine',
    'worktree introuvable : démarré dans le repo'
  ]);
});
