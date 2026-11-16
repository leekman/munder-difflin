import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { getBranch, mainRepoRoot, runGit } from './git';

/** Which project an agent works on, and whether it sits in its own worktree. */
export interface ProjectInfo {
  repoRoot: string;
  isGit: boolean;
  isolated: boolean;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  /** Sub-project the agent works in, relative POSIX to the checkout root. Absent at the root. */
  subdir?: string;
}

function canon(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Where an agent starts inside its worktree: the same sub-folder it had in the repo.
 *  Falls back to the worktree root when origCwd is the repo root or lies outside it. */
export function worktreeCwd(wtPath: string, repoRoot: string, origCwd: string): string {
  const rel = relative(repoRoot, origCwd);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return wtPath;
  return join(wtPath, rel);
}

export async function resolveProjectInfo(
  cwd: string,
  hint?: { baseBranch?: string }
): Promise<ProjectInfo> {
  const root = await mainRepoRoot(cwd);
  if (!root) return { repoRoot: canon(cwd), isGit: false, isolated: false };
  const repoRoot = canon(root);
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const toplevel = top.ok ? canon(top.stdout.trim()) : repoRoot;
  const isolated = toplevel !== repoRoot;
  const br = await getBranch(cwd);
  const info: ProjectInfo = { repoRoot, isGit: true, isolated };
  if (isolated) info.worktreePath = toplevel;
  const rel = relative(toplevel, canon(cwd));
  if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) info.subdir = rel.split(sep).join('/');
  if ('current' in br && br.current) info.branch = br.current;
  if (hint?.baseBranch) info.baseBranch = hint.baseBranch;
  return info;
}

/** Agent-facing description (French, like the rest of identity.md prose). */
export function projectBlock(info: ProjectInfo): string {
  if (!info.isGit) return `Projet : \`${info.repoRoot}\`.`;
  const sub = info.subdir ? ` Sous-projet : \`${info.subdir}\`.` : '';
  const head = `Projet : \`${basename(info.repoRoot)}\` (\`${info.repoRoot}\`).${sub}`;
  if (!info.isolated) {
    return `${head} Tu travailles directement dans ce repo, branche \`${info.branch ?? 'inconnue'}\`. D'autres agents peuvent travailler dans le même arbre.`;
  }
  const from = info.baseBranch ? ` créée depuis \`${info.baseBranch}\`` : '';
  return `${head} Tu travailles dans un worktree isolé \`${info.worktreePath}\`, branche \`${info.branch ?? 'inconnue'}\`${from}. Tes changements n'arrivent dans le repo qu'une fois mergés.`;
}
