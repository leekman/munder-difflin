/**
 * Monorepo scope actions wired to the store and the preload API: first load of
 * the floor scope, scope switch (via the pure `switchScope`) and resuming a
 * remembered team (same concurrency as `useRestoreTeam`).
 */
import { useStore, type Agent, type PersistedAgent } from './store';
import type { HarnessConfig } from './config';
import { respawnAgent } from './respawn';
import { parkEntries } from './parking';
import {
  sameScope, shouldPreEnable, switchScope, type FloorScope, type SavedTeam
} from '@/components/scopeFlow';

/** First load: read the floor scope (and its current team); a never-seen
 *  floor gets the pre-enable rule. */
export async function loadFloorScope(): Promise<void> {
  const st = useStore.getState();
  try {
    let scope = await window.cth.scopeGet();
    if (!scope) {
      const subs = await window.cth.floorSubprojects();
      scope = { enabled: shouldPreEnable(subs.rootHasManifest, subs.items.length), scope: [] };
      await window.cth.scopeSet(scope);
    }
    st.setFloorScope({ enabled: scope.enabled, scope: scope.scope });
    st.setCurrentTeamId(scope.teamId ?? null);
    st.setKnownTeams(await window.cth.teamsList(scope.scope));
  } catch (e) {
    console.warn('[scope] load failed', e);
    st.setFloorScope({ enabled: false, scope: [] });
  }
}

export type ApplyResult = { ok: true } | { ok: false; error: string; stale?: true };

/** Apply a new scope. Only the `enabled` flag changed → just store it; otherwise
 *  the team the user confirmed (`confirmedIds`) is saved then parked. On success
 *  with no known team for an enabled scope, « Composer l'équipe » opens directly. */
export async function applyFloorScope(to: FloorScope, confirmedIds: readonly string[]): Promise<ApplyResult> {
  const st = useStore.getState();
  const from = st.floorScope ?? { enabled: false, scope: [] };
  if (sameScope(from.scope, to.scope)) {
    if (from.enabled === to.enabled) return { ok: true };
    const teamId = st.currentTeamId;
    const r = await window.cth.scopeSet({ enabled: to.enabled, scope: to.scope, ...(teamId ? { teamId } : {}) });
    if (!r.ok) return { ok: false, error: r.error ?? 'scope not saved' };
    st.setFloorScope({ enabled: to.enabled, scope: to.scope });
    return { ok: true };
  }
  const currentTeamId = st.currentTeamId ?? undefined;
  const summary = st.knownTeams.find((t) => t.id === currentTeamId)?.summary ?? '';
  const res = await switchScope<Agent>({
    agents: () => useStore.getState().agents,
    queues: () => useStore.getState().messageQueues,
    // Same idle/parked reset as the store's own park.
    slim: (list) => parkEntries(list, {}, list.map((a) => a.id)).parked,
    parkPty: (ptyId) => window.cth.parkPty(ptyId),
    parkAgents: (ids) => useStore.getState().parkAgents(ids),
    teamsSave: (t) => window.cth.teamsSave(t),
    teamsForget: (scope, id) => window.cth.teamsForget(scope, id),
    scopeSet: (s) => window.cth.scopeSet(s),
    teamsList: (scope) => window.cth.teamsList(scope),
    currentTeamId
  }, from, to, summary, confirmedIds);
  const next = useStore.getState();
  if (!res.ok) {
    if (res.known) {
      // Parked but the scope was not written: the floor stays on `from`, and the
      // team just saved there is offered again.
      void next.setCurrentTeam(null);
      next.setKnownTeams(res.known);
    }
    return { ok: false, error: res.error, ...(res.stale ? { stale: true as const } : {}) };
  }
  // switchScope wrote the new scope without a teamId: store-only reset.
  next.setFloorScope({ enabled: to.enabled, scope: [...to.scope].sort() });
  next.setCurrentTeamId(null);
  next.setKnownTeams(res.known);
  if (res.notParked.length) {
    const n = res.notParked.length;
    next.setScopeNotice(`${n} agent${n > 1 ? "s n'ont" : " n'a"} pas pu être mis de côté : ${res.notParked.join(', ')}`);
  }
  if (res.known.length === 0 && to.enabled) next.setComposeTeamOpen(true);
  return { ok: true };
}

/** One resume at a time, whichever card or button started it. */
let resuming = false;
export const isResuming = (): boolean => resuming;

/** Respawn a remembered team: concurrent spawns, agents added in team order,
 *  queues given back then cleared from the saved team (never replayed twice),
 *  team touched and remembered as current. Returns the French notes to show
 *  (history lost, sub-project gone, failures). */
export async function resumeTeam(team: SavedTeam, config: HarnessConfig | null): Promise<string[]> {
  if (resuming) return [];
  resuming = true;
  try {
    return await resumeTeamNow(team, config);
  } finally {
    resuming = false;
  }
}

async function resumeTeamNow(team: SavedTeam, config: HarnessConfig | null): Promise<string[]> {
  const prevSel = useStore.getState().selectedId;
  const entries = team.agents as PersistedAgent[];
  let fresh = 0;
  let workdirGone = 0;
  let worktreeGone = 0;
  let alreadyHere = 0;
  const failures: string[] = [];
  const results = await Promise.all(entries.map(async (a) => {
    const r = await respawnAgent(a, config);
    if (!r.agent) {
      // « already exists » is fine only when that agent is on the floor already;
      // otherwise its PTY runs with no card — a failure to report.
      if ((r.error ?? '').includes('already exists') && useStore.getState().agents.some((x) => x.id === a.id)) {
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
  const st = useStore.getState();
  const back = new Set<string>();
  for (const agent of results) {
    if (!agent) continue;
    st.addAgent(agent);
    back.add(agent.id);
  }
  st.restoreQueues(Object.fromEntries(Object.entries(team.queues ?? {}).filter(([id]) => back.has(id))));
  if (back.size + alreadyHere > 0) {
    void st.setCurrentTeam(team.id);
    try {
      await window.cth.teamsTouch(team.scope, team.id);
      // The queues are back in the store: drop them from the file so a later
      // resume can never deliver them a second time.
      if (Object.keys(team.queues ?? {}).length > 0) {
        await window.cth.teamsSave({ id: team.id, scope: team.scope, summary: team.summary, agents: team.agents, queues: {} });
      }
    } catch (e) {
      console.warn('[scope] could not update the resumed team', e);
    }
    st.setKnownTeams(await window.cth.teamsList(team.scope).catch(() => st.knownTeams));
  }
  // addAgent selects each spawn; put the user back where they were.
  const after = useStore.getState();
  if (prevSel && after.agents.some((x) => x.id === prevSel)) after.select(prevSel);

  const notes: string[] = [];
  if (fresh) notes.push(fresh > 1 ? `${fresh} agents repartent sans historique` : '1 agent repart sans historique');
  if (workdirGone) notes.push(`sous-projet introuvable : démarré à la racine${workdirGone > 1 ? ` (${workdirGone} agents)` : ''}`);
  if (worktreeGone) notes.push(`worktree introuvable : démarré dans le repo${worktreeGone > 1 ? ` (${worktreeGone} agents)` : ''}`);
  if (failures.length) notes.push(`non relancé${failures.length > 1 ? 's' : ''} — ${failures.join(' ; ')}`);
  return notes;
}
