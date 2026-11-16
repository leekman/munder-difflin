'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const loadTs = require('./load-ts.cjs');
const { parkEntries } = loadTs('src/renderer/src/store/parking.ts');

const agent = (id, extra = {}) => ({
  id, name: id, description: '', project: 'p', tmuxTarget: '', cwd: '/repo',
  status: 'working', action: 'coding', progress: 40, ...extra
});

test('parkEntries: met de côté les workers, garde worktree/workdir, transfère les files', () => {
  const agents = [
    agent('god', { isGod: true, ptyId: 'pty-god' }),
    agent('a', { ptyId: 'pty-a', worktreePath: '/wt/a', workdir: 'apps/web', contextTokens: 5, recentAssistantText: 'x', carrying: 'file' }),
    agent('b', { ptyId: 'pty-b', worktreePath: '/wt/b', workdir: 'apps/api' })
  ];
  const queues = { god: [{ id: 'q0' }], a: [{ id: 'q1' }], b: [{ id: 'q2' }, { id: 'q3' }] };
  const r = parkEntries(agents, queues, ['a', 'b', 'inconnu']);
  assert.deepEqual(r.parked.map((p) => p.id), ['a', 'b']);
  assert.equal(r.parked[0].worktreePath, '/wt/a');
  assert.equal(r.parked[0].workdir, 'apps/web');
  assert.equal(r.parked[1].worktreePath, '/wt/b');
  assert.equal(r.parked[1].workdir, 'apps/api');
  for (const p of r.parked) {
    assert.equal(p.ptyId, undefined);
    assert.equal(p.status, 'idle');
    assert.equal(p.carrying, undefined);
    assert.equal('contextTokens' in p, false);
    assert.equal('recentAssistantText' in p, false);
  }
  assert.deepEqual(Object.keys(r.queues).sort(), ['a', 'b']);
  assert.equal(r.queues.b.length, 2);
  assert.deepEqual(r.remaining.map((x) => x.id), ['god']);
  assert.deepEqual(Object.keys(r.remainingQueues), ['god']);
});

test('parkEntries: un id inconnu seul ne change rien', () => {
  const agents = [agent('a')];
  const r = parkEntries(agents, { a: [{ id: 'q' }] }, ['zzz']);
  assert.equal(r.parked.length, 0);
  assert.deepEqual(r.queues, {});
  assert.equal(r.remaining.length, 1);
  assert.deepEqual(Object.keys(r.remainingQueues), ['a']);
});
