import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { runGit } from './git';
import { HIRE_LIMITS, isSafeRelPath } from '../shared/hire';

export interface Subproject { path: string; label: string; group: string; kinds: string[] }
export interface DetectOptions {
  maxDepth?: number;
  max?: number;
  isIgnored?: (rel: string) => Promise<boolean>;
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

function readDirs(abs: string): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  // Dirent.isDirectory() is false for symlinks: they are never followed.
  return entries.filter(e => e.isDirectory() && !skippedName(e.name)).map(e => e.name).sort();
}

function manifestKinds(abs: string): string[] {
  const kinds: string[] = [];
  for (const [file, kind] of MANIFESTS) {
    if (!kinds.includes(kind) && existsSync(join(abs, file))) kinds.push(kind);
  }
  return kinds;
}

export function rootHasManifest(repoRoot: string): boolean {
  return MANIFESTS.some(([file]) => existsSync(join(repoRoot, file)));
}

async function gitIgnored(repoRoot: string, rel: string): Promise<boolean> {
  return (await runGit(repoRoot, ['check-ignore', '-q', '--', rel])).ok;
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
  const isIgnored = opts.isIgnored ?? ((rel: string) => gitIgnored(repoRoot, rel));

  const found = new Map<string, Subproject>();
  let truncated = false;
  let level: string[] = [''];
  for (let depth = 1; depth <= maxDepth && level.length > 0 && !truncated; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      for (const name of readDirs(join(repoRoot, parent))) {
        const rel = parent ? `${parent}/${name}` : name;
        const kinds = manifestKinds(join(repoRoot, rel));
        if (kinds.length === 0) { next.push(rel); continue; }
        if (await isIgnored(rel)) continue;
        if (found.size >= max) { truncated = true; break; }
        found.set(rel, { path: rel, label: name, group: parent, kinds });
      }
      if (truncated) break;
    }
    level = next;
  }

  // Fallback: a group (parent of a retained project, never the repo root) also
  // lists its manifest-less sibling folders, except groups themselves.
  const groups = new Set<string>();
  for (const sp of found.values()) {
    for (let g = sp.group; g; g = parentOf(g)) groups.add(g);
  }
  for (const group of groups) {
    for (const name of readDirs(join(repoRoot, group))) {
      const rel = `${group}/${name}`;
      if (found.has(rel) || groups.has(rel)) continue;
      if (await isIgnored(rel)) continue;
      found.set(rel, { path: rel, label: name, group, kinds: [] });
    }
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
