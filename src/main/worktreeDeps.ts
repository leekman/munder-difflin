import { existsSync } from 'node:fs';
import { lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** Link the base checkout's dependencies into an isolated worktree. */
async function linkOne(baseDir: string, worktreeDir: string): Promise<DepLink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  if (!existsSync(baseNodeModules)) return { ok: true, skipped: true };

  try {
    await lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
    // node_modules does not exist in this worktree yet.
  }

  try {
    await symlink(baseNodeModules, worktreeNodeModules, process.platform === 'win32' ? 'junction' : null);
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Remove the dependency link before testing whether a worktree is dirty. */
async function unlinkOne(baseDir: string, worktreeDir: string): Promise<DepUnlink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');

  try {
    const stat = await lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      realpath(baseNodeModules),
      realpath(resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}

/** Link the checkout's dependencies into the worktree; when the agent works in a
 *  sub-project (`subdir`, relative to the checkout), link that sub-project's own
 *  node_modules too. */
export async function linkWorktreeDeps(baseDir: string, worktreeDir: string, subdir?: string): Promise<DepLink> {
  const root = await linkOne(baseDir, worktreeDir);
  if (!root.ok || !subdir) return root;
  const sub = await linkOne(join(baseDir, subdir), join(worktreeDir, subdir));
  return sub.ok ? { ok: true, skipped: root.skipped && sub.skipped } : sub;
}

/** Remove the dependency links (root and, if given, sub-project) before a dirty check. */
export async function unlinkWorktreeDeps(baseDir: string, worktreeDir: string, subdir?: string): Promise<DepUnlink> {
  const root = await unlinkOne(baseDir, worktreeDir);
  if (!root.ok || !subdir) return root;
  const sub = await unlinkOne(join(baseDir, subdir), join(worktreeDir, subdir));
  return sub.ok ? { ok: true, removed: root.removed || sub.removed } : sub;
}
