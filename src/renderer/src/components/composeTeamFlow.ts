/**
 * Pure state helpers for the "Compose the team" modal. No React, no window,
 * no I/O — loaded directly by test/compose-team-flow.test.cjs.
 */
import type { TeamResponse } from '@shared/teamPrompt';
import { HIRE_LIMITS, HIRE_PROVIDERS, HIRE_SPEC_V1, isSafeRelPath, validateHireManifest, type HireManifest } from '@shared/hire';
import { splitMissing, type FloorScope, type Subproject } from './scopeFlow';

export type ComposeStep = 'idle' | 'analyzing' | 'questions' | 'proposal' | 'written' | 'error';

/** Where an analysis (automatic) or a pasted answer (manual) leads. */
export function nextStep(_step: ComposeStep, res: TeamResponse): ComposeStep {
  switch (res.kind) {
    case 'questions': return 'questions';
    case 'agents': return 'proposal';
    default: return 'error';
  }
}

type FloorAgent = { name: string; description?: string; isGod?: boolean; isAssistant?: boolean };

/** The floor's current team as the prompt sees it: every worker agent
 *  (god and system assistants excluded). */
export function existingAgentsOf(agents: readonly FloorAgent[]): { name: string; description?: string }[] {
  return agents.filter((a) => !a.isGod && !a.isAssistant).map((a) => ({ name: a.name, description: a.description }));
}

/** "Compose the team" is the primary call to action while the floor has no worker yet. */
export function shouldHighlightCompose(agents: readonly FloorAgent[]): boolean {
  return existingAgentsOf(agents).length === 0;
}

export interface ComposeCard {
  manifest: HireManifest;
  why: string;
  checked: boolean;
  /** True for an agent the parser rejected: shown unchecked, not writable. */
  invalid: boolean;
  errors: string[];
}

/** `m` without a `workdir` outside `scope` (→ racine). No scope = left as is. */
function withScopedWorkdir(m: HireManifest, scope?: readonly string[]): HireManifest {
  if (!scope || m.workdir === undefined || scope.includes(m.workdir)) return m;
  const { workdir: _dropped, ...rest } = m;
  return rest as HireManifest;
}

/** One card per proposed agent (checked), then one per rejected agent (unchecked).
 *  With a `scope`, a `workdir` outside it starts at racine. */
export function cardsFromResponse(res: TeamResponse, scope?: readonly string[]): ComposeCard[] {
  if (res.kind !== 'agents') return [];
  return [
    ...res.agents.map((a) => ({ manifest: withScopedWorkdir(a.manifest, scope), why: a.why, checked: true, invalid: false, errors: [] })),
    ...res.invalid.map((x) => ({
      manifest: { spec: HIRE_SPEC_V1, name: x.name ?? '?' } as HireManifest,
      why: '',
      checked: false,
      invalid: true,
      errors: x.errors
    }))
  ];
}

/** Revalidates the checked, edited cards. `manifests` are the ones to send;
 *  `cardErrors[i]` holds card i's errors (empty when it passed or is unchecked).
 *  With a `scope`, a `workdir` outside it is replaced by racine (dropped). */
export function prepareWrite(cards: readonly ComposeCard[], scope?: readonly string[]): { manifests: HireManifest[]; cardErrors: string[][] } {
  const manifests: HireManifest[] = [];
  const cardErrors = cards.map((c) => {
    if (!c.checked || c.invalid) return c.invalid ? c.errors : [];
    const v = validateHireManifest(withScopedWorkdir(c.manifest, scope));
    if (v.ok && v.manifest) { manifests.push(v.manifest); return []; }
    return v.errors;
  });
  return { manifests, cardErrors };
}

/** Model ids the app offers for each hire provider, for the analysis prompt and
 *  the card pickers. `modelsFor` is the catalog lookup (injected for tests);
 *  entries without an id (the "CLI default" option) are skipped. */
export function modelIdsByProvider(modelsFor: (provider: string) => { id?: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of HIRE_PROVIDERS) {
    const ids = modelsFor(p).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length > 0) out[p] = ids;
  }
  return out;
}

/** Card `workdir` picker: racine (`''`) first, then each sub-project of the scope. */
export function workdirOptions(scope: readonly string[], items: readonly Subproject[]): { value: string; label: string }[] {
  return [
    { value: '', label: 'racine' },
    ...scope.map((p) => ({ value: p, label: items.find((i) => i.path === p)?.label ?? p }))
  ];
}

export const SCOPE_GONE = "Aucun sous-projet du périmètre n'existe plus — change le périmètre.";

/** Scope to send with an analysis: [] (whole repo) when the monorepo mode is
 *  off or the scope empty; otherwise the still-detected paths. A non-empty
 *  scope with every path gone is refused rather than silently widened. */
export function analysisScope(
  floorScope: Pick<FloorScope, 'enabled' | 'scope'> | null,
  items: readonly Subproject[]
): { ok: true; scope: string[] } | { ok: false; error: string } {
  if (!floorScope?.enabled || floorScope.scope.length === 0) return { ok: true, scope: [] };
  const { present } = splitMissing(floorScope.scope, items);
  return present.length > 0 ? { ok: true, scope: present } : { ok: false, error: SCOPE_GONE };
}

const trimSlashes = (p: string): string => p.replace(/\/+$/, '');

/** `Agent.workdir` for an agent spawned in `cwd`: its path relative to the
 *  floor repo when strictly inside it (non-empty, no `..`, ≤ 200 chars), else undefined. */
export function workdirOf(repo: string | null | undefined, cwd: string): string | undefined {
  if (!repo) return undefined;
  const root = trimSlashes(repo);
  const dir = trimSlashes(cwd.trim());
  if (!root || !dir.startsWith(`${root}/`)) return undefined;
  const rel = dir.slice(root.length + 1).split('/').filter((s) => s !== '' && s !== '.').join('/');
  if (!rel || rel.length > HIRE_LIMITS.workdir || !isSafeRelPath(rel)) return undefined;
  return rel;
}

/** AddAgentModal's starting folder on a floor: the hire's `workdir` when it
 *  exists, else the scope's only sub-project, else the repo root. */
export function initialHireCwd(
  repo: string,
  hireWorkdir: string | undefined,
  hireWorkdirExists: boolean,
  scope: readonly string[]
): string {
  const root = trimSlashes(repo);
  if (hireWorkdir && hireWorkdirExists) return `${root}/${hireWorkdir}`;
  if (scope.length === 1) return `${root}/${scope[0]}`;
  return repo;
}
