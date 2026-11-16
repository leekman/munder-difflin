import { slimAgents, type Agent, type PersistedAgent } from './store';

/** Mettre des agents de côté : on les sort du roster actif SANS les archiver
 *  (l'archive est un cul-de-sac visible, ici on veut une reprise propre plus
 *  tard). Leur worktree (`worktreePath`) et leur sous-projet (`workdir`) sont
 *  conservés, ainsi que leur file de messages. Pur : aucun accès au store. */
export function parkEntries(
  agents: Agent[],
  queues: Record<string, unknown[]>,
  ids: string[]
): {
  parked: PersistedAgent[];
  queues: Record<string, unknown[]>;
  remaining: Agent[];
  remainingQueues: Record<string, unknown[]>;
} {
  const wanted = new Set(ids);
  // Jamais le god ni un assistant système, même si leur id est demandé.
  const picked = agents.filter((a) => wanted.has(a.id) && !a.isGod && !a.isAssistant);
  const pickedIds = new Set(picked.map((a) => a.id));
  const remaining = agents.filter((a) => !pickedIds.has(a.id));
  // Le PTY est tué : on efface tout l'état live, comme archiveAgent.
  const parked = slimAgents(
    picked.map((a) => ({
      ...a,
      ptyId: undefined,
      status: 'idle' as const,
      action: 'parked',
      carrying: undefined,
      currentStation: undefined
    }))
  );
  const parkedQueues: Record<string, unknown[]> = {};
  const remainingQueues: Record<string, unknown[]> = {};
  for (const [id, q] of Object.entries(queues)) {
    if (pickedIds.has(id)) parkedQueues[id] = q;
    else remainingQueues[id] = q;
  }
  return { parked, queues: parkedQueues, remaining, remainingQueues };
}
