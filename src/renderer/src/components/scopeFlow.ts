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
  parkAgents(ids: string[]): { parked: unknown[]; queues: Record<string, unknown[]> };
  teamsSave(t: { id?: string; scope: string[]; summary: string; agents: unknown[]; queues: Record<string, unknown[]> }): Promise<SaveResult>;
  teamsForget(scope: string[], id: string): Promise<unknown>;
  scopeSet(s: FloorScope): Promise<{ ok: boolean; error?: string }>;
  teamsList(scope: string[]): Promise<SavedTeam[]>;
  /** The floor's current team, when it came from an earlier save (composed or resumed). */
  currentTeamId?: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SwitchResult =
  | { ok: true; known: SavedTeam[]; notParked: string[] }
  /** `stale`: the team changed since the confirmation, nothing was done.
   *  `known`: agents were parked but the scope was not written — the teams of
   *  the OLD scope (the just-saved one included) to offer. */
  | { ok: false; error: string; stale?: true; known?: SavedTeam[] };

/**
 * Switch the floor to `to`, parking exactly `confirmedIds` (the team the user
 * confirmed; if the live team differs, nothing happens and `stale` is set).
 * Binding order: snapshot → save (or forget an empty current team) → park
 * every PTY → park the store entries → write the scope → list the known teams
 * of the new scope. A failed save parks nothing. An agent whose PTY could not
 * be parked stays on the floor and leaves the saved team (`notParked`).
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

  // (2) Save the outgoing team under the OLD scope.
  let savedId: string | null = null;
  try {
    if (toPark.length > 0) {
      const res = await deps.teamsSave({
        ...(deps.currentTeamId ? { id: deps.currentTeamId } : {}),
        scope: fromScope, summary, agents: deps.slim(toPark), queues: queuesOf(toPark)
      });
      if (!res.ok) return { ok: false, error: res.error };
      savedId = res.team.id;
    } else if (deps.currentTeamId) {
      // Composed but never launched: not worth keeping in the history.
      await deps.teamsForget(fromScope, deps.currentTeamId);
    }
  } catch (e) {
    return { ok: false, error: errText(e) };
  }

  // (3) Cut the PTYs (worktrees kept). A PTY that would not die keeps its card.
  const failed = new Set<string>();
  for (const a of toPark) {
    if (!a.ptyId) continue;
    try {
      const r = await deps.parkPty(a.ptyId) as { ok?: boolean } | undefined;
      if (r && r.ok === false) failed.add(a.id);
    } catch {
      failed.add(a.id);
    }
  }
  const parked = toPark.filter((a) => !failed.has(a.id));
  if (failed.size > 0 && savedId) {
    try {
      if (parked.length > 0 || deps.currentTeamId) {
        await deps.teamsSave({ id: savedId, scope: fromScope, summary, agents: deps.slim(parked), queues: queuesOf(parked) });
      } else {
        await deps.teamsForget(fromScope, savedId);
      }
    } catch { /* resume skips an agent already on the floor */ }
  }

  // (4) Drop the parked entries from the floor.
  deps.parkAgents(parked.map((a) => a.id));
  const notParked = toPark.filter((a) => failed.has(a.id)).map((a) => a.name);

  // (5) New scope, (6) its remembered teams.
  try {
    const set = await deps.scopeSet({ enabled: to.enabled, scope: [...to.scope].sort() });
    if (!set.ok) {
      const known = await deps.teamsList(fromScope).catch(() => [] as SavedTeam[]);
      return { ok: false, error: set.error ?? 'scope not saved', known };
    }
    return { ok: true, known: await deps.teamsList([...to.scope].sort()), notParked };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
