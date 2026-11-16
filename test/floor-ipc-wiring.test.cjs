const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const main = () => readFileSync('src/main/index.ts', 'utf8');
const preload = () => readFileSync('src/preload/index.ts', 'utf8');

function handlerBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} is present`);
  const end = source.indexOf('\n});', start);
  return source.slice(start, end > start ? end : start + 600);
}

test('roster IPC routes by the sending window (evt.sender.id)', () => {
  const source = main();
  const write = handlerBody(source, "ipcMain.handle('roster:write'");
  assert.match(write, /evt\.sender\.id/);
  assert.match(write, /'no floor repo'/);
  assert.doesNotMatch(write, /\broster\.write\(/, 'roster:write never reaches the legacy roster.json store');
  const readSync = handlerBody(source, "ipcMain.on('roster:readSync'");
  assert.doesNotMatch(readSync, /\broster\.read\(/);
  const read = handlerBody(source, "ipcMain.handle('roster:read'");
  assert.doesNotMatch(read, /\broster\.read\(/);
});

test('migrateLegacyRoster is awaited before the first createWindow( in whenReady', () => {
  const source = main();
  // The helper itself awaits the migration…
  const fn = source.indexOf('async function migrateLegacyRosterOfHome(');
  assert.ok(fn >= 0, 'migration helper exists');
  assert.match(source.slice(fn, fn + 1500), /await migrateLegacyRoster\(/);
  // …and whenReady awaits the helper before the first window.
  const start = source.indexOf('app.whenReady().then(');
  assert.ok(start >= 0);
  // Code only: comments may mention createWindow() before the real call.
  const body = source.slice(start).replace(/^\s*\/\/.*$/gm, '');
  const mig = body.indexOf('await migrateLegacyRosterOfHome(');
  const win = body.indexOf('createWindow(');
  assert.ok(mig >= 0, 'migration runs at startup');
  assert.ok(win > mig, 'migration precedes the first window');
});

test('dev changeHome re-binds in place: migrates the new home, blocks and reloads every window', () => {
  const source = main();
  const start = source.indexOf("ipcMain.handle('config:changeHome'");
  const body = source.slice(start, source.indexOf('app.relaunch();', start));
  assert.match(body, /if \(isDev\) \{/);
  assert.match(body, /await migrateLegacyRosterOfHome\(\)/);
  assert.match(body, /bootstrapHiveServices\(\)/);
  assert.match(body, /floorWritesBlocked\.add\(/);
  assert.match(body, /\.reload\(\)/);
});

test('pty:spawn refuses a window whose reload is pending', () => {
  const source = main();
  const start = source.indexOf("ipcMain.handle('pty:spawn'");
  assert.match(source.slice(start, start + 900), /floorWritesBlocked\.has\(evt\.sender\.id\)/);
});

test("changeHome move copies the per-repo 'rosters' folder", () => {
  const source = main();
  assert.match(source, /for \(const sub of \['hive', 'palace', 'roster\.json', 'roster-backups', 'rosters'\]\)/);
});

test('floor IPC channels are registered in main', () => {
  const source = main();
  for (const ch of ['floor:repoSync', 'floor:chooseRepo', 'floor:listRepos', 'floor:openForRepo', 'floor:subprojects']) {
    assert.ok(source.includes(`'${ch}'`), `${ch} is registered`);
  }
  assert.match(source, /ipcMain\.on\('floor:repoSync'/);
});

test('preload exposes the floor API', () => {
  const source = preload();
  for (const name of ['floorRepoSync', 'chooseFloorRepo', 'listFloorRepos', 'openFloorForRepo', 'floorSubprojects']) {
    assert.match(source, new RegExp(`\\b${name}:`), `${name} is exposed`);
  }
  assert.match(source, /sendSync\('floor:repoSync'\)/);
});

test('closing a floor keeps it in openFloors while the app quits', () => {
  const source = main();
  assert.match(source, /let appQuitting = false/);
  const quit = handlerBody(source, "app.on('before-quit'");
  assert.match(quit, /appQuitting = true/);
  const teardown = source.slice(source.indexOf('function teardownAndQuit'), source.indexOf('function teardownAndQuit') + 200);
  assert.match(teardown, /appQuitting = true/);
});

test('reset archives every per-repo roster too', () => {
  const source = main();
  const reset = handlerBody(source, "ipcMain.handle('app:resetAll'");
  assert.match(reset, /roster\.archive\(\)/);
  assert.match(reset, /listRepoRosters\(/);
});

function closedHandler(source) {
  const start = source.indexOf("win.on('closed'", source.indexOf('function createWindow('));
  assert.ok(start >= 0, 'createWindow has a closed handler');
  return source.slice(start, source.indexOf('\n  });', start));
}

test('the closed handler only drops a floor from openFloors on a deliberate close', () => {
  const closed = closedHandler(main());
  assert.match(closed, /appQuitting/);
  assert.match(closed, /floors\.unbind\(ownerId\)/);
});

test('on Windows/Linux closing the last window keeps its floor (that close is the quit)', () => {
  const closed = closedHandler(main());
  assert.match(closed, /process\.platform !== 'darwin' && allWindows\.size === 0/);
  assert.match(closed, /!lastWindowQuits\) persistOpenFloors\(\)/);
  const del = closed.indexOf('allWindows.delete(win)');
  assert.ok(del >= 0 && del < closed.indexOf('allWindows.size === 0'), 'size is read after this window is removed');
});

test('startup migration passes the home floor and registered repos as fallbacks', () => {
  const source = main();
  assert.match(source, /migrateLegacyRoster\(home, resolveAgentRepo, \{ home: homeFloor, registeredRepos \}\)/);
  assert.match(source, /const homeFloor = \(await floorRepoFromInput\(home\)\) \?\? home/);
});

test('team:analyze pins a fresh session id per hidden run', () => {
  const analyze = handlerBody(main(), "ipcMain.handle('team:analyze'");
  assert.match(analyze, /runTeamAnalysis\(input, \(prompt\) => runHiddenClaude\(prompt, \{[\s\S]*sessionId: randomUUID\(\)/);
});

test('team:analyze is read-only: Bash is disallowed too', () => {
  const analyze = handlerBody(main(), "ipcMain.handle('team:analyze'");
  assert.match(analyze, /disallowedTools: \['Edit', 'Write', 'NotebookEdit', 'Bash'\]/);
});

test('team:analyze pre-accepts the folder trust prompt before the hidden run', () => {
  const analyze = handlerBody(main(), "ipcMain.handle('team:analyze'");
  const trust = analyze.indexOf('ensureClaudePermissionsAccepted(repo)');
  assert.ok(trust >= 0, 'trust prompt pre-accepted');
  assert.ok(trust < analyze.indexOf('runHiddenClaude('), 'before the hidden session');
  assert.match(analyze, /try \{ ensureClaudePermissionsAccepted\(repo\); \} catch/);
});

test('team:* handlers use the sender bound repo, never the renderer path', () => {
  const source = main();
  assert.match(source, /function teamRepoOf\(sender: Electron\.WebContents\)[\s\S]{0,80}floors\.repoOf\(sender\.id\)/);
  for (const ch of ['team:analyze', 'team:cancel', 'team:prompt', 'team:write', 'team:openFolder']) {
    const body = handlerBody(source, `ipcMain.handle('${ch}'`);
    assert.match(body, /teamRepoOf\(evt\.sender\)/, `${ch} routes by sender`);
    assert.doesNotMatch(body, /teamRepoFromInput|floorRepoFromInput/, `${ch} ignores the renderer path`);
  }
  assert.match(handlerBody(source, "ipcMain.handle('team:write'"), /manifests\.length > TEAM_INPUT_CAPS\.manifests/);
  assert.match(source, /sanitizeTeamInput\(raw, repoRoot/);
});

test('team analyses are aborted with their window, on reload, and at quit', () => {
  const source = main();
  assert.match(source, /teamAnalyses\.set\(repo, \{ ctl, ownerId: evt\.sender\.id \}\)/);
  const closed = closedHandler(source);
  assert.match(closed, /abortTeamAnalyses\(ownerId\)/);
  const nav = source.slice(source.indexOf("win.webContents.on('did-start-navigation'"));
  assert.match(nav.slice(0, nav.indexOf('\n  });')), /isMainFrame && !details\.isSameDocument\) abortTeamAnalyses\(ownerId\)/);
  const t = source.indexOf('function teardownAndQuit');
  const teardown = source.slice(t, source.indexOf('\n}', t));
  assert.match(teardown, /abortTeamAnalyses\(\)/);
});

function closeHandler(source) {
  const start = source.indexOf("win.on('close', (e)", source.indexOf('function createWindow('));
  assert.ok(start >= 0, 'createWindow has a close interceptor');
  return source.slice(start, source.indexOf('\n  });', start));
}

test('closing the primary while other windows remain is a plain floor close', () => {
  const source = main();
  const close = closeHandler(source);
  assert.match(close, /if \(isFloor \|\| allWindows\.size > 1\) \{/);
  const floorBranch = close.slice(close.indexOf('if (isFloor || allWindows.size > 1)'));
  assert.ok(floorBranch.indexOf('countByOwner(wc)') < floorBranch.indexOf("app:closeRequested"), 'floor branch first');
  const closed = closedHandler(source);
  assert.match(closed, /if \(isFloor \|\| allWindows\.size > 0\) \{ try \{ ptyManager\.killByOwner\(wc\)/);
});

test('the promoted primary becomes the default PTY sink', () => {
  const closed = closedHandler(main());
  assert.match(closed, /mainWindow = w; ptyManager\.attachWebContents\(w\.webContents\); break;/);
});

test('floor:listRepos normalizes registered repos in parallel', () => {
  const list = handlerBody(main(), "ipcMain.handle('floor:listRepos'");
  assert.match(list, /await Promise\.all\(\(cfg\.registeredRepos \?\? \[\]\)\.map\(floorRepoFromInput\)\)/);
  assert.doesNotMatch(list, /for \(const raw of cfg\.registeredRepos/);
});

test('choosing a repo resolves its harness and switches the app when it differs', () => {
  const source = main();
  const start = source.indexOf("ipcMain.handle('floor:chooseRepo'");
  const body = source.slice(start, source.indexOf("ipcMain.handle('floor:harnessInfo'", start));
  assert.match(body, /harnessForRepo\(repo\)/);
  assert.match(body, /switchHarness: target\.harness/, 'other floors open → ask first');
  assert.match(body, /setRepoHarness\(repo, target\.harness\)/);
  assert.match(body, /changeHarnessHome\(target\.harness, 'fresh', repo\)/);
});

test('a harness switch links the asking repo and closes floors of other harnesses', () => {
  const source = main();
  const start = source.indexOf('async function changeHarnessHome(');
  const body = source.slice(start, source.indexOf('app.relaunch();', start));
  const link = body.indexOf('setRepoHarness(linkRepo, newHome)');
  const close = body.indexOf('closeFloorsNotIn(newHome)');
  const repoint = body.indexOf('writeConfig({ harnessHome: newHome })');
  assert.ok(link > 0 && close > link && repoint > close);
  assert.match(source, /ipcMain\.handle\('config:changeHome'[\s\S]{0,600}changeHarnessHome\(p\.newHome, mode, floors\.repoOf\(evt\.sender\.id\)\)/);
});

test('restored floors are limited to repos of the running harness', () => {
  const source = main();
  const start = source.indexOf('app.whenReady().then(');
  assert.match(source.slice(start), /restored = \(cfg\.openFloors \?\? \[\]\)\.filter\(\(r\) => existsSync\(r\) && \(!links\[r\] \|\| links\[r\] === home\)\)/);
});
