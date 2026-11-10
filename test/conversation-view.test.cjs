'use strict';
// Conversation view of the Terminal tab: transcript parsing (shared/conversation)
// and the incremental tail reader (main/conversation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
fs.mkdirSync(path.join(out, 'shared'));
fs.mkdirSync(path.join(out, 'main'));
for (const rel of ['shared/conversation', 'main/conversation', 'shared/terminalMenu']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, 'src', `${rel}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  fs.writeFileSync(path.join(out, `${rel}.js`), js, 'utf8');
}
const conv = require(path.join(out, 'shared/conversation.js'));
const { readConversation } = require(path.join(out, 'main/conversation.js'));
const { detectTerminalMenu, menuKeystrokes } = require(path.join(out, 'shared/terminalMenu.js'));

const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
const asst = (uuid, content) => ({ type: 'assistant', uuid, message: { role: 'assistant', content } });
const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('user, assistant text and tool calls become entries; results fold into their call', () => {
  const items = conv.parseTranscriptChunk(jsonl(
    user('u1', 'Fix the tests'),
    asst('a1', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]),
    user('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'all good' }])
  ));
  const entries = conv.foldConversation([], items);
  assert.deepEqual(entries.map((e) => e.kind), ['user', 'assistant', 'tool']);
  assert.equal(entries[2].name, 'Bash');
  assert.equal(entries[2].summary, 'npm test');
  assert.equal(entries[2].result, 'all good');
  assert.equal(entries[2].isError, false);
});

test('a tool result arriving in a later chunk attaches to the earlier call', () => {
  const first = conv.foldConversation([], conv.parseTranscriptChunk(jsonl(
    asst('a1', [{ type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: '/x/y.ts' } }])
  )));
  assert.equal(first[0].result, undefined);
  const next = conv.foldConversation(first, conv.parseTranscriptChunk(jsonl(
    user('u3', [{ type: 'tool_result', tool_use_id: 'tu9', content: [{ type: 'text', text: 'boom' }], is_error: true }])
  )));
  assert.equal(next.length, 1);
  assert.equal(next[0].result, 'boom');
  assert.equal(next[0].isError, true);
  assert.equal(next[0].summary, '/x/y.ts');
});

test('plumbing is hidden: meta, sidechain, reminders, command stdout', () => {
  const items = conv.parseTranscriptChunk(jsonl(
    user('m', 'caveat', { isMeta: true }),
    user('s', 'subagent prompt', { isSidechain: true }),
    user('r', '<system-reminder>x</system-reminder>'),
    user('o', '<local-command-stdout>done</local-command-stdout>'),
    user('c', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    { type: 'summary', summary: 'x' },
    'not an object'
  ) + '{torn');
  assert.deepEqual(items, [{ kind: 'event', id: 'c', ts: undefined, text: '/clear' }]);
});

test('thinking blocks and images are surfaced', () => {
  const items = conv.parseTranscriptChunk(jsonl(
    user('u', [{ type: 'text', text: 'look' }, { type: 'image', source: {} }]),
    asst('a', [{ type: 'thinking', thinking: 'hmm' }])
  ));
  assert.equal(items[0].kind, 'user');
  assert.equal(items[0].images, 1);
  assert.equal(items[1].kind, 'thinking');
});

test('readConversation reads incrementally and holds back a torn line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-file-'));
  const file = path.join(dir, 's.jsonl');
  assert.equal(readConversation(file, -1), null, 'missing file → null');
  fs.writeFileSync(file, jsonl(user('u1', 'hello')));
  const a = readConversation(file, -1);
  assert.equal(a.reset, true);
  assert.equal(a.truncated, false);
  assert.equal(a.items.length, 1);
  const torn = JSON.stringify(user('u2', 'world'));
  fs.appendFileSync(file, torn.slice(0, 10));
  const b = readConversation(file, a.offset);
  assert.equal(b.items.length, 0);
  assert.equal(b.offset, a.offset);
  fs.appendFileSync(file, torn.slice(10) + '\n');
  const c = readConversation(file, b.offset);
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].text, 'world');
  assert.equal(c.reset, false);
  // File rewritten smaller → reset.
  fs.writeFileSync(file, jsonl(user('u3', 'new')));
  const d = readConversation(file, c.offset);
  assert.equal(d.reset, true);
  assert.equal(d.items[0].text, 'new');
});

test('entries are capped', () => {
  const items = Array.from({ length: conv.MAX_ENTRIES + 5 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: 'x' }));
  const entries = conv.foldConversation([], items);
  assert.equal(entries.length, conv.MAX_ENTRIES);
  assert.equal(entries[0].id, 'u5');
});

test('a boxed permission menu at the bottom of the screen is detected', () => {
  const screen = [
    '● Bash(rm -rf build)',
    '',
    '╭──────────────────────────────────────────────╮',
    '│ Bash command                                 │',
    '│                                              │',
    '│ Do you want to proceed?                      │',
    '│ ❯ 1. Yes                                     │',
    "│   2. Yes, and don't ask again for rm         │",
    '│   3. No, and tell Claude what to do (esc)    │',
    '╰──────────────────────────────────────────────╯',
    '',
  ];
  const m = detectTerminalMenu(screen);
  assert.ok(m);
  assert.equal(m.question, 'Do you want to proceed?');
  assert.deepEqual(m.options.map((o) => o.label), ['Yes', "Yes, and don't ask again for rm", 'No, and tell Claude what to do (esc)']);
  assert.equal(m.selected, 0);
  assert.deepEqual(menuKeystrokes(m, 2), ['\x1b[B', '\x1b[B', '\r']);
  assert.deepEqual(menuKeystrokes(m, 0), ['\r']);
});

test('an unboxed menu with the cursor further down, and a footer', () => {
  const m = detectTerminalMenu([
    'Resume the previous Remote Control session?',
    '  1. Yes, resume',
    '❯ 2. No, start fresh',
    '',
    'Enter to confirm · Esc to cancel',
  ]);
  assert.ok(m);
  assert.equal(m.question, 'Resume the previous Remote Control session?');
  assert.equal(m.selected, 1);
  assert.deepEqual(menuKeystrokes(m, 0), ['\x1b[A', '\r']);
});

test('no menu: plain numbered lists without a cursor, or menus scrolled far up', () => {
  assert.equal(detectTerminalMenu(['Steps:', '1. build', '2. test', '> ']), null);
  const old = ['Q?', '❯ 1. A', '  2. B', ...Array.from({ length: 12 }, (_, i) => `line ${i}`)];
  assert.equal(detectTerminalMenu(old), null);
  assert.equal(detectTerminalMenu([]), null);
});

test('agent mentions: by name or id, whole words, in order, self excluded', () => {
  const agents = [
    { id: 'qa-code-reviewer-mw9', name: 'QA & Code Reviewer' },
    { id: 'god', name: 'Michael' },
    { id: 'addon-ui-dev', name: 'Addon UI Developer' },
    { id: 'x1', name: 'QA' },
  ];
  const text = "J'ai confié la popup à addon UI developer, puis qa-code-reviewer-mw9 relira. Michael suit.";
  assert.deepEqual(conv.findAgentMentions(text, agents, 'god').map((a) => a.id), ['addon-ui-dev', 'qa-code-reviewer-mw9']);
  assert.deepEqual(conv.findAgentMentions('Developers rock', agents), []);
});

test('tool targets: hive outbox writes and MCP-style recipients', () => {
  assert.deepEqual(conv.toolTargets('Write', {
    file_path: 'C:\\hive\\agents\\god\\outbox\\m1.json',
    content: JSON.stringify({ to: 'addon-ui-dev', act: 'request', subject: 'Popup' })
  }), ['addon-ui-dev']);
  assert.deepEqual(conv.toolTargets('Write', { file_path: '/tmp/x.json', content: '{"to":"a"}' }), []);
  assert.deepEqual(conv.toolTargets('mcp__hive__send', { to: ['a', 'b'] }), ['a', 'b']);
  const items = conv.parseTranscriptChunk(JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [
    { type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/h/outbox/m.json', content: '{"to":"qa"}' } }
  ] } }) + '\n');
  assert.deepEqual(items[0].targets, ['qa']);
});

test('internal markup is removed from user bubbles, pasted text is kept', () => {
  const items = conv.parseTranscriptChunk([
    { type: 'user', uuid: 'p', message: { content: 'Réponse :\n<pasted_content id="e338">\nRecommandé partout.\nAttention aux objets stackables\n</pasted_content id="e338">' } },
    { type: 'user', uuid: 'r', message: { content: '<system-reminder>ctx</system-reminder>\nVraie question ?' } },
    { type: 'user', uuid: 'i', message: { content: [{ type: 'text', text: '<ide_selection>x</ide_selection>' }, { type: 'text', text: 'Explique ça' }] } },
    { type: 'user', uuid: 'o', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(items.map((i) => i.text), [
    'Réponse :\nRecommandé partout.\nAttention aux objets stackables',
    'Vraie question ?',
    'Explique ça',
  ]);
});

test('plan: TodoWrite replaces the list, TaskCreate/TaskUpdate edit it', () => {
  const rec = (id, name, input) => ({ type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, text) => ({ type: 'user', uuid: `r${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  const lines = [
    rec('t1', 'TodoWrite', { todos: [
      { content: 'Lire le code', status: 'completed', activeForm: 'Lecture du code' },
      { content: 'Corriger', status: 'in_progress', activeForm: 'Correction' },
      { content: 'Tester', status: 'pending' },
    ] }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  let entries = conv.foldConversation([], conv.parseTranscriptChunk(lines));
  assert.deepEqual(conv.derivePlan(entries).map((s) => [s.title, s.status]), [
    ['Lire le code', 'completed'], ['Corriger', 'in_progress'], ['Tester', 'pending']
  ]);
  const tasks = [
    rec('c1', 'TaskCreate', { subject: 'Étape A', activeForm: 'Faisant A' }), res('c1', 'Task #7 created successfully'),
    rec('c2', 'TaskCreate', { subject: 'Étape B' }), res('c2', 'Task #8 created successfully'),
    rec('u1', 'TaskUpdate', { taskId: '7', status: 'completed' }), res('u1', 'ok'),
    rec('u2', 'TaskUpdate', { taskId: '8', status: 'in_progress' }), res('u2', 'ok'),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  entries = conv.foldConversation([], conv.parseTranscriptChunk(tasks));
  assert.deepEqual(conv.derivePlan(entries).map((s) => [s.id, s.title, s.status]), [
    ['7', 'Étape A', 'completed'], ['8', 'Étape B', 'in_progress']
  ]);
});
