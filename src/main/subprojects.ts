import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { runGit } from './git';
import { HIRE_LIMITS, isSafeRelPath } from '../shared/hire';

export interface Subproject { path: string; label: string; group: string; kinds: string[] }
export interface DetectOptions {
  maxDepth?: number;
  max?: number;
  /** Which of `rels` are git-ignored (one call per batch). */
  ignored?: (rels: string[]) => Promise<Set<string>>;
}

const MANIFESTS: Array<[string, string]> = [
  ['package.json', 'npm'], ['composer.json', 'composer'],
  ['pyproject.toml', 'python'], ['requirements.txt', 'python'],
  ['go.mod', 'go'], ['Cargo.toml', 'rust'], ['Gemfile', 'ruby'],
  ['pom.xml', 'maven'], ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'],
  ['DESCRIPTION', 'r']
];
const SKIPPED_NAMES = new Set(['node_modules', 'vendor', 'dist', 'build', '.venv']);

function skippedName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_NAMES.has(name);
}

interface Listing { dirs: string[]; kinds: string[] }

/** One readdir per folder: its descendable sub-folders and its manifest kinds. */
async function list(abs: string): Promise<Listing> {
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return { dirs: [], kinds: [] }; }
  // Dirent.isDirectory() is false for symlinks: they are never followed.
  const dirs = entries.filter(e => e.isDirectory() && !skippedName(e.name)).map(e => e.name).sort();
  const files = new Set(entries.filter(e => !e.isDirectory()).map(e => e.name));
  const kinds: string[] = [];
  for (const [file, kind] of MANIFESTS) {
    if (!kinds.includes(kind) && files.has(file)) kinds.push(kind);
  }
  return { dirs, kinds };
}

export function rootHasManifest(repoRoot: string): boolean {
  return MANIFESTS.some(([file]) => existsSync(join(repoRoot, file)));
}

/** `git check-ignore` on a batch of paths (exit 1 = none ignored; any failure = none). */
async function gitIgnored(repoRoot: string, rels: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < rels.length; i += 200) {
    const r = await runGit(repoRoot, ['check-ignore', '-z', '--', ...rels.slice(i, i + 200)]);
    if (r.ok) for (const p of r.stdout.split('\0')) if (p) out.add(p);
  }
  return out;
}

const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** Folders of a monorepo that hold a manifest (shallowest wins, never descended
 *  further), plus manifest-less siblings that sit beside them in a group. */
export async function detectSubprojects(
  repoRoot: string,
  opts: DetectOptions = {}
): Promise<{ items: Subproject[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 4;
  const max = opts.max ?? 300;
  const ignored = opts.ignored ?? ((rels: string[]) => gitIgnored(repoRoot, rels));
  const listings = new Map<string, Listing>();
  const listOf = async (rel: string): Promise<Listing> => {
    let l = listings.get(rel);
    if (!l) { l = await list(join(repoRoot, rel)); listings.set(rel, l); }
    return l;
  };

  const found = new Map<string, Subproject>();
  let truncated = false;
  let level: string[] = [''];
  for (let depth = 1; depth <= maxDepth && level.length > 0 && !truncated; depth++) {
    const parents = await Promise.all(level.map(listOf));
    const children = level.flatMap((parent, i) =>
      parents[i].dirs.map(name => ({ parent, name, rel: parent ? `${parent}/${name}` : name })));
    const kids = await Promise.all(children.map(c => listOf(c.rel)));
    const withManifest = children.filter((_, i) => kids[i].kinds.length > 0).map(c => c.rel);
    const skip = withManifest.length ? await ignored(withManifest) : new Set<string>();
    const next: string[] = [];
    for (const [i, c] of children.entries()) {
      const kinds = kids[i].kinds;
      if (kinds.length === 0) { next.push(c.rel); continue; }
      if (skip.has(c.rel)) continue;
      if (found.size >= max) { truncated = true; break; }
      found.set(c.rel, { path: c.rel, label: c.name, group: c.parent, kinds });
    }
    level = next;
  }

  // Fallback: a group (parent of a retained project, never the repo root) also
  // lists its manifest-less sibling folders, except groups themselves.
  const groups = new Set<string>();
  for (const sp of found.values()) {
    for (let g = sp.group; g; g = parentOf(g)) groups.add(g);
  }
  const siblings: Array<{ group: string; name: string; rel: string }> = [];
  for (const group of groups) {
    for (const name of (await listOf(group)).dirs) {
      const rel = `${group}/${name}`;
      if (!found.has(rel) && !groups.has(rel)) siblings.push({ group, name, rel });
    }
  }
  const skipSib = siblings.length ? await ignored(siblings.map(s => s.rel)) : new Set<string>();
  for (const s of siblings) {
    if (!skipSib.has(s.rel)) found.set(s.rel, { path: s.rel, label: s.name, group: s.group, kinds: [] });
  }

  let items = [...found.values()].sort((a, b) =>
    a.group === b.group ? a.label.localeCompare(b.label) : a.group.localeCompare(b.group));
  if (items.length > max) { items = items.slice(0, max); truncated = true; }
  return { items, truncated };
}

/** A floor-relative `workdir` sent by the renderer, checked on disk: relative,
 *  no `..`, ≤ 200 chars, an existing folder whose realpath stays inside the
 *  repo's (a symlink out of the repo is refused). Returns `<repo>/<rel>` (the
 *  path as the floor names it), or null. */
export async function resolveWorkdir(repo: string, rel: unknown): Promise<string | null> {
  if (typeof rel !== 'string') return null;
  const clean = rel.replace(/\/+$/, '');
  if (!clean || clean.length > HIRE_LIMITS.workdir || !isSafeRelPath(clean)) return null;
  try {
    const abs = join(repo, clean);
    const [root, real] = await Promise.all([realpath(repo), realpath(abs)]);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return (await stat(real)).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}
