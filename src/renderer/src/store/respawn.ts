import { floorRepo as storeFloorRepo, type Agent, type PersistedAgent } from './store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from './config';
import { roleForHiveSpawn } from '@shared/agentRole';

export type RestoreNote = 'worktree-gone' | 'workdir-gone';

function joinPath(root: string, sub: string): string {
  const rel = sub.replace(/^\/+|\/+$/g, '');
  return rel ? `${root.replace(/\/+$/, '')}/${rel}` : root;
}

/** Où relancer un agent. Pur : `worktreeAlive` vient d'une sonde faite par l'appelant.
 *  Worktree vivant → on rentre dans son sous-dossier (`workdir`) ; un agent plus
 *  ancien sans `workdir` dont le `cwd` est déjà dans le worktree garde ce `cwd`
 *  plutôt que de retomber sur la racine. Worktree mort → `a.cwd` + note. */
export function restoreCwd(
  a: { cwd: string; worktreePath?: string; workdir?: string },
  worktreeAlive: boolean,
  _floorRepo: string | null
): { cwd: string; note?: RestoreNote } {
  if (!a.worktreePath) return { cwd: a.cwd };
  if (!worktreeAlive) return { cwd: a.cwd, note: 'worktree-gone' };
  if (a.workdir !== undefined) return { cwd: joinPath(a.worktreePath, a.workdir) };
  const root = a.worktreePath.replace(/\/+$/, '');
  if (a.cwd.startsWith(`${root}/`)) return { cwd: a.cwd };
  return { cwd: a.worktreePath };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await window.cth.statAbs(path);
    return !!st?.exists;
  } catch {
    return false;
  }
}

/** Relance un agent avec son id d'origine (reprise de session). Le corps par agent
 *  de `useRestoreTeam`, réutilisable. Ne touche pas au store : l'appelant ajoute
 *  l'agent retourné. `error` contient « already exists » quand un PTY du même id
 *  tourne déjà. */
export async function respawnAgent(
  a: PersistedAgent,
  config: HarnessConfig | null
): Promise<{ agent: Agent | null; error?: string; fresh?: boolean; note?: string }> {
  try {
    const provider = inferAgentProvider(a.command, a.provider);
    const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
    if (!command || !a.cwd) {
      // Pas de recette de spawn (entrée antérieure à `command`, sans config).
      return { agent: null, error: 'no saved command' };
    }
    const [exe, ...args] = tokenizeCommand(command);
    const ptyId = a.ptyId ?? `pty-${a.id}`;
    // Le worktree d'un agent isolé survit au redémarrage : on y rentre (au bon
    // sous-dossier) au lieu de le ré-isoler. S'il a été supprimé, gitIsRepo est faux
    // et on retombe sur le cwd d'origine.
    const worktreeAlive = a.worktreePath ? await window.cth.gitIsRepo(a.worktreePath) : false;
    const picked = restoreCwd(a, worktreeAlive, storeFloorRepo);
    let cwd = picked.cwd;
    let note: string | undefined = picked.note;
    const worktreeGone = picked.note === 'worktree-gone';
    if (worktreeGone) {
      console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
    }
    // Le sous-projet a pu disparaître : retour à la racine (worktree ou dépôt de l'étage).
    const checkSub = worktreeAlive ? cwd !== a.worktreePath : a.workdir !== undefined && !!a.workdir;
    if (checkSub && !(await dirExists(cwd))) {
      cwd = (worktreeAlive ? a.worktreePath : storeFloorRepo) ?? a.cwd;
      note = 'workdir-gone';
      console.warn(`[restore] workdir gone for ${a.id}; falling back to ${cwd}`);
    }
    const res = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // Le worktree (s'il y en a un) existe déjà : on y entre, on ne le recrée pas.
      isolate: false,
      // Reprend la session CLI précédente si elle est enregistrée ; sans effet sinon.
      resume: true,
      hive: { id: a.id, name: a.name, provider, cwd, role: roleForHiveSpawn(a) }
    });
    if (!res.ok) {
      if (!(res.error ?? '').includes('already exists')) console.error('[restore] spawn failed for', a.id, res.error);
      return { agent: null, error: res.error ?? 'spawn failed' };
    }
    return {
      agent: {
        ...a,
        provider,
        ptyId,
        archived: false,
        status: 'idle',
        action: worktreeGone
          ? 'worktree gone — using base repo'
          : note === 'workdir-gone' ? 'subfolder gone — using repo root' : 'starting up',
        // Worktree disparu : on l'oublie pour ne plus sonder un chemin mort.
        worktreePath: worktreeGone ? undefined : a.worktreePath,
        // Sous-projet disparu : on repart de la racine.
        workdir: note === 'workdir-gone' ? undefined : a.workdir,
        // Crush démarre nu et rend le seed ici ; useHive le tape après le boot.
        seedPrompt: res.seedPrompt,
        carrying: undefined,
        currentStation: 'desk',
        recentTextTs: Date.now()
      },
      fresh: res.resumeNotFound ? true : undefined,
      note
    };
  } catch (e) {
    console.error('[restore] error for', a.id, e);
    return { agent: null, error: e instanceof Error ? e.message : String(e) };
  }
}
