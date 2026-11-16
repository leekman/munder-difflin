/**
 * Monorepo scope + remembered teams, stored by MAIN under
 * `<home>/teams/<repoSlug>/`.
 *
 *   floor.json                                  { enabled, scope, teamId? } for the floor
 *   <scopeKey>/<createdAt-compact>-<id>.json    one remembered team
 *
 * Not in the roster: the renderer rewrites the whole roster and `RosterStore.write`
 * filters fields, so main-owned state would be lost there. Same durability though:
 * temp file + rename, so a crash never leaves a truncated file.
 *
 * A stored scope is kept verbatim even if a folder has since disappeared; the
 * renderer filters for display.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeRelPath } from '../shared/hire';
import { repoSlug } from './roster';
import { MAX_SCOPE, MAX_TEAM_SUMMARY, TEAM_ID_RE } from '../shared/scopeLimits';

/** `teamId` = the remembered team the floor's current team came from (resumed or composed). */
export interface FloorScope { enabled: boolean; scope: string[]; teamId?: string }
export interface SavedTeam {
  id: string; repoRoot: string; scope: string[]; summary: string;
  createdAt: string; usedAt: string;
  agents: unknown[];
  queues: Record<string, unknown[]>;
}

const MAX_AGENTS = 50;

/** Validated, de-duplicated, sorted copy of a scope. Throws on an unsafe path. */
function cleanScope(scope: unknown): string[] {
  if (!Array.isArray(scope) || scope.length > MAX_SCOPE) throw new Error('invalid scope');
  for (const p of scope) {
    if (typeof p !== 'string' || !isSafeRelPath(p)) throw new Error('unsafe scope path');
  }
  return [...new Set(scope as string[])].sort();
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !TEAM_ID_RE.test(id)) throw new Error('invalid team id');
  return id;
}

export function scopeKey(scope: string[]): string {
  const sorted = [...scope].sort();
  const label = sorted.length === 0
    ? 'all'
    : sorted.join('+').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'scope';
  return `${label}-${createHash('sha1').update(sorted.join('\n')).digest('hex').slice(0, 8)}`;
}

function repoDir(home: string, repoRoot: string): string {
  return join(home, 'teams', repoSlug(repoRoot));
}

function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function readFloorScope(home: string, repoRoot: string): FloorScope | null {
  try {
    const v = JSON.parse(readFileSync(join(repoDir(home, repoRoot), 'floor.json'), 'utf8')) as Partial<FloorScope>;
    if (!v || typeof v.enabled !== 'boolean' || !Array.isArray(v.scope)) return null;
    const out: FloorScope = { enabled: v.enabled, scope: cleanScope(v.scope) };
    // A hand-edited or corrupted id is dropped, not trusted.
    if (typeof v.teamId === 'string' && TEAM_ID_RE.test(v.teamId)) out.teamId = v.teamId;
    return out;
  } catch {
    return null;
  }
}

export function writeFloorScope(home: string, repoRoot: string, s: FloorScope): void {
  const scope = cleanScope(s?.scope);
  const teamId = s.teamId === undefined || s.teamId === null ? undefined : checkId(s.teamId);
  const dir = repoDir(home, repoRoot);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'floor.json'), { enabled: !!s.enabled, scope, ...(teamId ? { teamId } : {}) });
}

/** Team file names in a scope folder, with the id parsed out of the name. */
function teamFiles(dir: string): Array<{ name: string; id: string }> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: Array<{ name: string; id: string }> = [];
  for (const name of names) {
    const m = /^[0-9TZ]+-(.+)\.json$/.exec(name);
    if (m && TEAM_ID_RE.test(m[1])) out.push({ name, id: m[1] });
  }
  return out;
}

function readTeam(file: string): SavedTeam | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedTeam>;
    if (!v || typeof v.id !== 'string' || !Array.isArray(v.agents) || !Array.isArray(v.scope)) return null;
    if (typeof v.createdAt !== 'string' || typeof v.usedAt !== 'string') return null;
    return {
      id: v.id, repoRoot: String(v.repoRoot ?? ''), scope: v.scope as string[], summary: String(v.summary ?? ''),
      createdAt: v.createdAt, usedAt: v.usedAt, agents: v.agents,
      queues: v.queues && typeof v.queues === 'object' && !Array.isArray(v.queues) ? v.queues : {}
    };
  } catch (e) {
    console.warn('[teamStore] skipping unreadable team file', file, e);
    return null;
  }
}

export function listTeams(home: string, repoRoot: string, scope: string[]): SavedTeam[] {
  const dir = join(repoDir(home, repoRoot), scopeKey(cleanScope(scope)));
  const teams: SavedTeam[] = [];
  for (const f of teamFiles(dir)) {
    const t = readTeam(join(dir, f.name));
    if (t) teams.push(t);
  }
  return teams.sort((a, b) => (a.usedAt < b.usedAt ? 1 : a.usedAt > b.usedAt ? -1 : 0));
}

export function saveTeam(
  home: string,
  repoRoot: string,
  t: Omit<SavedTeam, 'id' | 'createdAt' | 'usedAt' | 'repoRoot'> & { id?: string }
): SavedTeam {
  const scope = cleanScope(t?.scope);
  if (!Array.isArray(t.agents) || t.agents.length > MAX_AGENTS) throw new Error('invalid agents');
  if (!t.queues || typeof t.queues !== 'object' || Array.isArray(t.queues)) throw new Error('invalid queues');
  const summary = (typeof t.summary === 'string' ? t.summary : '').trim().slice(0, MAX_TEAM_SUMMARY);
  if (t.agents.length === 0 && !summary) throw new Error('empty team');
  const id = t.id === undefined ? randomUUID() : checkId(t.id);

  const dir = join(repoDir(home, repoRoot), scopeKey(scope));
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const existing = teamFiles(dir).find((f) => f.id === id);
  const prev = existing ? readTeam(join(dir, existing.name)) : null;
  const createdAt = prev?.createdAt ?? now;
  const saved: SavedTeam = { id, repoRoot, scope, summary, createdAt, usedAt: now, agents: t.agents, queues: t.queues };
  const name = existing?.name ?? `${createdAt.replace(/[-:.]/g, '')}-${id}.json`;
  atomicWrite(join(dir, name), saved);
  return saved;
}

export function touchTeam(home: string, repoRoot: string, scope: string[], id: string): void {
  checkId(id);
  const dir = join(repoDir(home, repoRoot), scopeKey(cleanScope(scope)));
  const f = teamFiles(dir).find((x) => x.id === id);
  if (!f) return;
  const t = readTeam(join(dir, f.name));
  if (t) atomicWrite(join(dir, f.name), { ...t, usedAt: new Date().toISOString() });
}

export function forgetTeam(home: string, repoRoot: string, scope: string[], id: string): boolean {
  checkId(id);
  const dir = join(repoDir(home, repoRoot), scopeKey(cleanScope(scope)));
  const f = teamFiles(dir).find((x) => x.id === id);
  if (!f) return false;
  rmSync(join(dir, f.name), { force: true });
  return !existsSync(join(dir, f.name));
}
