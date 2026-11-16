'use strict';

/**
 * Regression coverage for #430: agents can publish JSON manually and leave
 * literal line-break bytes inside a string value. The router should narrowly
 * repair that malformed class, while irreparable JSON remains quarantined and
 * becomes observable in the hive log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-malformed-outbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });

  const outbox = path.join(home, 'hive', 'agents', 'worker-1', 'outbox');
  return { hive, outbox };
}

function writeOutbox(outbox, filename, raw) {
  const file = path.join(outbox, filename);
  fs.writeFileSync(file, raw, 'utf8');
  return file;
}

function eventsFor(hive, filename) {
  return hive.logTail(500).filter((entry) => entry.file === filename);
}

test('valid JSON with an escaped newline keeps the fast path', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'valid.json';
  const body = 'first line\nsecond line';
  writeOutbox(outbox, filename, JSON.stringify({
    to: 'god', act: 'done', subject: 'done', body, requires_reply: false
  }));

  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, body);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', filename)), true);
  assert.deepEqual(eventsFor(hive, filename), []);
});

test('literal LF inside a JSON string is repaired and routed', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'literal-lf.json';
  const LF = String.fromCharCode(0x0A);
  const raw = '{"to":"god","act":"done","subject":"done","body":"first line'
    + LF
    + 'second line","requires_reply":false}';
  const file = writeOutbox(outbox, filename, raw);

  assert.equal(fs.readFileSync(file).includes(Buffer.from([0x0A])), true);
  assert.throws(() => JSON.parse(raw));
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, `first line${LF}second line`);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', filename)), true);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${filename}`)), false);
  const events = eventsFor(hive, filename);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'outbox-repair');
  assert.equal(events[0].from, 'worker-1');
  assert.equal(events[0].repair, 'literal-line-break');
});

test('literal CRLF inside a JSON string is repaired and preserved', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'literal-crlf.json';
  const CRLF = String.fromCharCode(0x0D, 0x0A);
  const raw = '{"to":"god","act":"done","subject":"done","body":"first line'
    + CRLF
    + 'second line","requires_reply":false}';
  const file = writeOutbox(outbox, filename, raw);

  assert.equal(fs.readFileSync(file).includes(Buffer.from([0x0D, 0x0A])), true);
  assert.throws(() => JSON.parse(raw));
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, `first line${CRLF}second line`);
  assert.equal(eventsFor(hive, filename).filter((entry) => entry.kind === 'outbox-repair').length, 1);
  assert.equal(eventsFor(hive, filename).some((entry) => entry.kind === 'drop'), false);
});

test('irreparable structural JSON is logged and quarantined', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'structural.json';
  writeOutbox(outbox, filename, '{"to":"god","body":');

  assert.equal(hive.routeOnce(), 0);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(fs.existsSync(path.join(outbox, filename)), false);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${filename}`)), true);

  const events = eventsFor(hive, filename);
  assert.equal(events.filter((entry) => entry.kind === 'outbox-repair').length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'drop');
  assert.equal(events[0].reason, 'malformed-json');
  assert.equal(events[0].from, 'worker-1');
  assert.equal('error' in events[0], false, 'parser context and raw payload must not enter the durable log');
});

test('escaped quotes and backslashes keep their JSON semantics', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'escaped.json';
  const body = 'quoted: "hello"; path: C:\\tmp; escaped newline: \\n';
  writeOutbox(outbox, filename, JSON.stringify({ to: 'god', body }));

  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, body);
  assert.deepEqual(eventsFor(hive, filename), []);
});

test('an irreparable poison file does not block a valid file in the same pass', async (t) => {
  const { hive, outbox } = await floor(t);
  writeOutbox(outbox, 'a-poison.json', '{"to":"god","body":');
  writeOutbox(outbox, 'b-good.json', JSON.stringify({ to: 'god', act: 'inform', body: 'still routed' }));

  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('god-1')[0].body, 'still routed');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'bad-a-poison.json')), true);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'b-good.json')), true);
  assert.equal(eventsFor(hive, 'a-poison.json')[0].reason, 'malformed-json');
});

// Observed live on Windows (2026-11-10): every worker's `done` carried a report
// path written by hand with single backslashes. `\U`, `\d`, `\s` are not JSON
// escapes, the router quarantined each message, and the orchestrator never
// heard that the work was finished — the whole floor sat idle.
test('lone backslashes in a Windows path are repaired and routed', async (t) => {
  const { hive, outbox } = await floor(t);
  const filename = 'windows-path.json';
  const BS = '\\';
  const raw = '{\n  "to": "god",\n  "act": "done",\n  "subject": "A2 \u2014 termin\u00e9",\n'
    + '  "body": "Rapport : C:' + BS + 'Users' + BS + 'damien' + BS + 'sites' + BS + 'aa-l1d-wt' + BS + 'audit.md' + BS + 'n' + 'suite",\n'
    + '  "in_reply_to": "x"\n}';
  writeOutbox(outbox, filename, raw);

  assert.throws(() => JSON.parse(raw));
  assert.equal(hive.routeOnce(), 1);
  const [msg] = hive.inbox('god-1');
  // Literal backslashes survive; the writer's valid `\n` escape stays a newline.
  assert.equal(msg.body, 'Rapport : C:\\Users\\damien\\sites\\aa-l1d-wt\\audit.md\nsuite');
  assert.equal(msg.act, 'done');
  assert.equal(fs.existsSync(path.join(outbox, '.sent', `bad-${filename}`)), false);
  const events = eventsFor(hive, filename);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'outbox-repair');
  assert.equal(events[0].repair, 'invalid-escape');
});

test('\\u not followed by four hex digits is a literal backslash', async (t) => {
  const { hive, outbox } = await floor(t);
  const raw = '{"to":"god","body":"C:\\users\\caf\\u00e9"}';
  writeOutbox(outbox, 'lower-u.json', raw);
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, 'C:\\users\\caf\u00e9');
});

test('both repairs together: literal line break and lone backslash', async (t) => {
  const { hive, outbox } = await floor(t);
  const LF = String.fromCharCode(0x0A);
  const raw = '{"to":"god","body":"line one' + LF + 'C:\\Temp\\x"}';
  writeOutbox(outbox, 'both.json', raw);
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1')[0].body, `line one${LF}C:\\Temp\\x`);
  const repair = eventsFor(hive, 'both.json')[0].repair;
  assert.ok(repair.includes('literal-line-break') && repair.includes('invalid-escape'), repair);
});

test('a quarantined file tells its sender it was not delivered', async (t) => {
  const { hive, outbox } = await floor(t);
  writeOutbox(outbox, 'broken.json', '{"to":"god","body":');

  assert.equal(hive.routeOnce(), 0);
  assert.equal(hive.inbox('god-1').length, 0);
  const notices = hive.inbox('worker-1');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].from, 'system');
  assert.equal(notices[0].act, 'inform');
  assert.match(notices[0].subject, /NOT delivered/);
  assert.match(notices[0].body, /broken\.json/);
});
