/**
 * Pure logic of the monorepo scope switch (panel « Périmètre », known teams).
 * No React, no window, no store — loaded directly by test/scope-flow.test.cjs.
 * Every I/O goes through the injected `SwitchDeps`.
 */
import type { Agent } from '@/store/store';
import type { CthApi, SavedTeamInfo } from '../../../preload';

export type SavedTeam = SavedTeamInfo;
export type Subproject = Awaited<ReturnType<CthApi['floorSubprojects']>>['items'][number];
/** Monorepo state of a floor, as main stores it (`scope` = sorted relative paths, [] = whole repo). */
export interface FloorScope { enabled: boolean; scope: string[]; teamId?: string }

export const SUMMARY_MAX = 300;

export function sameScope(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((p) => set.has(p));
}

function labelOf(path: string, items: readonly Subproject[]): string {
  return items.find((i) => i.path === path)?.label ?? path.split('/').filter(Boolean).pop() ?? path;
}

/** Header chip text: 'tout le repo', 'live', 'live + core', 'live + core + 1'. */
export function scopeLabel(scope: readonly string[], items: readonly Subproject[]): string {
  if (scope.length === 0) return 'tout le repo';
  const head = scope.slice(0, 2).map((p) => labelOf(p, items)).join(' + ');
  return scope.length > 2 ? `${head} + ${scope.length - 2}` : head;
}

/** First opening of a floor: monorepo mode on when the root has no manifest and ≥ 2 sub-projects. */
export function shouldPreEnable(rootHasManifest: boolean, count: number): boolean {
  return !rootHasManifest && count >= 2;
}

/** Scope paths still detected vs. gone from the repo (shown struck « introuvable »). */
export function splitMissing(scope: readonly string[], items: readonly Subproject[]): { present: string[]; missing: string[] } {
  const known = new Set(items.map((i) => i.path));
  return { present: scope.filter((p) => known.has(p)), missing: scope.filter((p) => !known.has(p)) };
}

/** Statuses meaning a turn is in progress (the agent would be cut mid-work). */
const BUSY = new Set<string>(['working', 'thinking', 'compacting', 'blocked']);

type FloorAgent = Pick<Agent, 'id' | 'name' | 'status'> & { ptyId?: string; description?: string; isGod?: boolean; isAssistant?: boolean };

export interface SwitchPlan<A extends FloorAgent = Agent> { toPark: A[]; busy: A[]; needsConfirm: boolean }

/** Who leaves the floor on a scope switch: every worker (never god nor assistants). */
export function planScopeSwitch<A extends FloorAgent>(agents: readonly A[]): SwitchPlan<A> {
  const toPark = agents.filter((a) => !a.isGod && !a.isAssistant);
  const busy = toPark.filter((a) => BUSY.has(a.status));
  return { toPark, busy, needsConfirm: toPark.length > 0 };
}

/** Fallback team summary: `N agents : <nom> — <description> ; …`, ≤ 300 chars. */
export function localSummary(agents: readonly { name: string; description?: string }[]): string {
  const n = agents.length;
  const list = agents.map((a) => (a.description?.trim() ? `${a.name} — ${a.description.trim()}` : a.name)).join(' ; ');
  return `${n} agent${n > 1 ? 's' : ''} : ${list}`.slice(0, SUMMARY_MAX);
}

/** Non-final statuses of the hive board (`HiveTask.status` = todo | doing | blocked | done).
 *  An allowlist: an unknown hand-written status is not counted as open. */
const OPEN_TASK = new Set(['todo', 'doing', 'blocked']);

/** Open board tasks assigned to one of `ids`, from the raw `hiveTasks()` payload. */
export function countOpenTasks(raw: unknown, ids: readonly string[]): number {
  const tasks = (raw as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return 0;
  const wanted = new Set(ids);
  return tasks.filter((t: { status?: unknown; assignee?: unknown } | null) =>
    !!t && typeof t.status === 'string' && OPEN_TASK.has(t.status)
    && typeof t.assignee === 'string' && wanted.has(t.assignee)).length;
}

type SaveResult = { ok: true; team: SavedTeam } | { ok: false; error: string };

export interface SwitchDeps<A extends FloorAgent = Agent> {
  agents(): A[];
  queues(): Record<string, unknown[]>;
  /** Persisted (slim) form of the agents, as `parkAgents` would return them. */
  slim(agents: A[]): unknown[];
  /** Cuts a PTY by its pty id, keeping the worktree. */
  parkPty(ptyId: string): Promise<unknown>;
  /** Drops the entries from the floor; returns their queues as they are NOW. */
  parkAgents(ids: string[]): { parked: unknown[]; queues: Record<string, unknown[]> };
  teamsSave(t: { id?: string; scope: string[]; summary: string; agents: unknown[]; queues: Record<string, unknown[]> }): Promise<SaveResult>;
  teamsForget(scope: string[], id: string): Promise<unknown>;
  scopeSet(s: FloorScope): Promise<{ ok: boolean; error?: string }>;
  teamsList(scope: string[]): Promise<SavedTeam[]>;
  /** The floor's current team, when it came from an earlier save (composed or resumed). */
  currentTeamId?: string;
  /** That team as saved (when known): its entries not on the floor are kept,
   *  and it is only ever forgotten when it holds no saved agent. */
  currentTeam?: Pick<SavedTeam, 'id' | 'agents' | 'queues'>;
}

const idOf = (e: unknown): string | undefined => {
  const id = (e as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
};

/** Queues without their empty entries, for a stable comparison. */
function nonEmptyQueues(q: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => Array.isArray(v) && v.length > 0));
}

function sameQueues(a: Record<string, unknown[]>, b: Record<string, unknown[]>): boolean {
  const x = nonEmptyQueues(a);
  const y = nonEmptyQueues(b);
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => JSON.stringify(x[k]) === JSON.stringify(y[k]));
}

/** A `parkPty` answer for a PTY that was already dead: nothing left to cut. */
const ptyAlreadyGone = (r: { ok?: boolean; error?: string } | undefined): boolean =>
  !!r && r.ok === false && typeof r.error === 'string' && r.error.startsWith('no pty');

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SwitchResult =
  | { ok: true; known: SavedTeam[]; notParked: string[] }
  /** `stale`: the team changed since the confirmation, nothing was done.
   *  `known`: agents were parked but the scope was not written — the teams of
   *  the OLD scope (the just-saved one included) to offer. */
  | { ok: false; error: string; stale?: true; known?: SavedTeam[]; notParked?: string[] };

/**
 * Switch the floor to `to`, parking exactly `confirmedIds` (the team the user
 * confirmed; if the live team differs, nothing happens and `stale` is set).
 * Binding order: snapshot → save (or forget an empty current team) → park
 * every PTY → park the store entries → write the scope → list the known teams
 * of the new scope. A failed save parks nothing. An agent whose PTY could not
 * be parked stays on the floor and leaves the saved team (`notParked`). Saved
 * entries of the current team that are not on the floor are kept with their
 * queues; a team with saved agents is never forgotten.
 */
export async function switchScope<A extends FloorAgent>(
  deps: SwitchDeps<A>,
  from: FloorScope,
  to: FloorScope,
  summaryOfCurrent: string,
  confirmedIds: readonly string[]
): Promise<SwitchResult> {
  // (1) Snapshot BEFORE anything is cut: entries + their pending queues.
  const { toPark } = planScopeSwitch(deps.agents());
  if (!sameScope(toPark.map((a) => a.id), confirmedIds)) {
    return { ok: false, stale: true, error: "L'équipe a changé depuis la confirmation." };
  }
  const allQueues = deps.queues();
  const queuesOf = (list: A[]): Record<string, unknown[]> => {
    const out: Record<string, unknown[]> = {};
    for (const a of list) if (allQueues[a.id]?.length) out[a.id] = allQueues[a.id];
    return out;
  };
  const fromScope = [...from.scope].sort();
  const summary = summaryOfCurrent.trim().slice(0, SUMMARY_MAX) || localSummary(toPark);
  const teamId = deps.currentTeam?.id ?? deps.currentTeamId;
  // Saved entries not on the floor (e.g. a resume that failed for them): they
  // stay in the team with their queues — never dropped by a re-save.
  const onFloor = new Set(deps.agents().map((a) => a.id));
  const savedExtras = (deps.currentTeam?.agents ?? []).filter((e) => {
    const id = idOf(e);
    return !id || !onFloor.has(id);
  });
  const extraQueues: Record<string, unknown[]> = {};
  for (const e of savedExtras) {
    const id = idOf(e);
    const q = id ? deps.currentTeam?.queues?.[id] : undefined;
    if (id && q?.length) extraQueues[id] = q;
  }
  const teamOf = (list: A[], queues: Record<string, unknown[]> = queuesOf(list)) => ({
    agents: [...deps.slim(list), ...savedExtras],
    queues: { ...queues, ...extraQueues }
  });

  // (2) Save the outgoing team under the OLD scope.
  let savedId: string | null = null;
  try {
    if (toPark.length > 0) {
      const res = await deps.teamsSave({
        ...(teamId ? { id: teamId } : {}),
        scope: fromScope, summary, ...teamOf(toPark)
      });
      if (!res.ok) return { ok: false, error: res.error };
      savedId = res.team.id;
    } else if (deps.currentTeam && deps.currentTeam.agents.length === 0) {
      // Composed but never launched (nothing saved in it): not worth keeping.
      // A team with saved agents is never forgotten automatically.
      await deps.teamsForget(fromScope, deps.currentTeam.id);
    }
  } catch (e) {
    return { ok: false, error: errText(e) };
  }

  // (3) Cut the PTYs (worktrees kept). A PTY that would not die keeps its card;
  // one already dead (« no pty ») has nothing left to cut and counts as parked.
  const failed = new Set<string>();
  for (const a of toPark) {
    if (!a.ptyId) continue;
    try {
      const r = await deps.parkPty(a.ptyId) as { ok?: boolean; error?: string } | undefined;
      if (r && r.ok === false && !ptyAlreadyGone(r)) failed.add(a.id);
    } catch {
      failed.add(a.id);
    }
  }
  const parked = toPark.filter((a) => !failed.has(a.id));
  // Whether the saved team still describes the parked agents (for (4)).
  let holdsParked = !!savedId;
  if (failed.size > 0 && savedId) {
    try {
      if (parked.length > 0) {
        await deps.teamsSave({ id: savedId, scope: fromScope, summary, ...teamOf(parked) });
      } else if (!teamId) {
        // Nobody left: a team created by this switch would be empty history.
        await deps.teamsForget(fromScope, savedId);
        holdsParked = false;
      } else {
        // Nobody left and a pre-existing team: leave it as saved (never empty);
        // resume treats agents already on the floor as present.
        holdsParked = false;
      }
    } catch { /* resume skips an agent already on the floor */ }
  }

  // (4) Drop the parked entries from the floor. Their queues are read again at
  // this point: a message queued while the PTYs were cut must travel too.
  const out = deps.parkAgents(parked.map((a) => a.id));
  if (savedId && holdsParked && parked.length > 0 && !sameQueues(out.queues, queuesOf(parked))) {
    try {
      await deps.teamsSave({ id: savedId, scope: fromScope, summary, ...teamOf(parked, nonEmptyQueues(out.queues)) });
    } catch { /* the snapshot saved at (2) stands */ }
  }
  const notParked = toPark.filter((a) => failed.has(a.id)).map((a) => a.name);

  // (5) New scope, (6) its remembered teams.
  let set: { ok: boolean; error?: string };
  try {
    set = await deps.scopeSet({ enabled: to.enabled, scope: [...to.scope].sort() });
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  if (!set.ok) {
    const known = await deps.teamsList(fromScope).catch(() => [] as SavedTeam[]);
    return { ok: false, error: set.error ?? 'scope not saved', known, notParked };
  }
  // The scope is written: the store must follow it even if the list fails.
  const known = await deps.teamsList([...to.scope].sort()).catch(() => [] as SavedTeam[]);
  return { ok: true, known, notParked };
}

export interface ResumeDeps<E extends { id: string; name: string }, A extends { id: string }> {
  /** Respawn one saved entry; `error` holds « already exists » when its PTY runs. */
  respawn(entry: E): Promise<{ agent: A | null; error?: string; fresh?: boolean; note?: string }>;
  isOnFloor(id: string): boolean;
  addAgent(agent: A): void;
  restoreQueues(queues: Record<string, unknown[]>): void;
  setCurrentTeam(id: string): void;
  teamsTouch(scope: string[], id: string): Promise<unknown>;
  teamsSave(t: { id: string; scope: string[]; summary: string; agents: unknown[]; queues: Record<string, unknown[]> }): Promise<unknown>;
  teamsList(scope: string[]): Promise<SavedTeam[]>;
  setKnownTeams(list: SavedTeam[]): void;
  warn?(msg: string, e: unknown): void;
}

/**
 * Respawn a remembered team: concurrent spawns, agents added in team order,
 * queues given back then cleared from the saved team (never replayed twice),
 * team touched and remembered as current. Returns the French notes to show
 * (history lost, sub-project gone, failures). Agents that fail keep their
 * entry and their queue in the saved team.
 */
export async function resumeSavedTeam<E extends { id: string; name: string }, A extends { id: string }>(
  deps: ResumeDeps<E, A>,
  team: Pick<SavedTeam, 'id' | 'scope' | 'summary' | 'agents' | 'queues'>
): Promise<string[]> {
  const entries = team.agents as E[];
  let fresh = 0;
  let workdirGone = 0;
  let worktreeGone = 0;
  let alreadyHere = 0;
  const failures: string[] = [];
  const results = await Promise.all(entries.map(async (a) => {
    const r = await deps.respawn(a);
    if (!r.agent) {
      // « already exists » is fine only when that agent is on the floor already;
      // otherwise its PTY runs with no card — a failure to report.
      if ((r.error ?? '').includes('already exists') && deps.isOnFloor(a.id)) {
        alreadyHere++;
      } else {
        failures.push(`${a.name} : ${r.error ?? 'échec du lancement'}`);
      }
      return null;
    }
    if (r.fresh) fresh++;
    if (r.note === 'workdir-gone') workdirGone++;
    if (r.note === 'worktree-gone') worktreeGone++;
    return r.agent;
  }));
  const back = new Set<string>();
  for (const agent of results) {
    if (!agent) continue;
    deps.addAgent(agent);
    back.add(agent.id);
  }
  const queues = team.queues ?? {};
  deps.restoreQueues(Object.fromEntries(Object.entries(queues).filter(([id]) => back.has(id))));
  if (back.size + alreadyHere > 0) {
    deps.setCurrentTeam(team.id);
    try {
      await deps.teamsTouch(team.scope, team.id);
      // Queues given back to the store leave the file so a later resume can
      // never deliver them twice; agents that failed to respawn keep theirs.
      const kept = Object.fromEntries(Object.entries(queues).filter(([id]) => !back.has(id) && !deps.isOnFloor(id)));
      if (Object.keys(kept).length !== Object.keys(queues).length) {
        await deps.teamsSave({ id: team.id, scope: team.scope, summary: team.summary, agents: team.agents, queues: kept });
      }
    } catch (e) {
      deps.warn?.('[scope] could not update the resumed team', e);
    }
    const list = await deps.teamsList(team.scope).catch(() => null);
    if (list) deps.setKnownTeams(list);
  }

  const notes: string[] = [];
  if (fresh) notes.push(fresh > 1 ? `${fresh} agents repartent sans historique` : '1 agent repart sans historique');
  if (workdirGone) notes.push(`sous-projet introuvable : démarré à la racine${workdirGone > 1 ? ` (${workdirGone} agents)` : ''}`);
  if (worktreeGone) notes.push(`worktree introuvable : démarré dans le repo${worktreeGone > 1 ? ` (${worktreeGone} agents)` : ''}`);
  if (failures.length) notes.push(`non relancé${failures.length > 1 ? 's' : ''} — ${failures.join(' ; ')}`);
  return notes;
}
