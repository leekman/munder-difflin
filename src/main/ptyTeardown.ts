/** Pure decision of `teardownPty` (main/index.ts), kept apart so it is tested
 *  without Electron. `keepWorktree` = mise de côté (`pty:park`). */
export interface TeardownPlan {
  /** none: no worktree; keep: left on disk (park); gated: ephemeral worker's
   *  safety-gated removal; remove: immediate removal. */
  worktree: 'none' | 'keep' | 'gated' | 'remove';
  /** Broadcast `hive:agentArchived` (the renderer archives the card). Never on
   *  a park: the renderer would archive the agent and lose its queue. */
  archiveCard: boolean;
}

export function teardownPlan(o: { hasWorktree: boolean; isWorker: boolean; keepWorktree: boolean }): TeardownPlan {
  const worktree: TeardownPlan['worktree'] = !o.hasWorktree
    ? 'none'
    : o.keepWorktree ? 'keep' : o.isWorker ? 'gated' : 'remove';
  return { worktree, archiveCard: o.isWorker && !o.keepWorktree };
}
