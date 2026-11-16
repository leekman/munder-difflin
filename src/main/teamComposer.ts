import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAgentDraftPrompt, buildTeamPrompt, parseTeamResponse, MAX_AGENT_REQUEST, TEAM_SIZE,
  type AgentDraftInput, type TeamPromptInput, type TeamResponse
} from '../shared/teamPrompt';
import { HIRE_LIMITS, HIRE_PROVIDERS, isSafeRelPath, validateHireManifest, type HireManifest } from '../shared/hire';
import { repoSlug } from './roster';
import { MAX_SCOPE } from '../shared/scopeLimits';

export type TeamRunner = (prompt: string) => Promise<{ ok: boolean; text?: string; error?: string }>;

const RETRY_SUFFIX = "\n\nTa réponse précédente n'était pas un JSON valide : réponds uniquement avec l'objet JSON demandé.";

/** Runs the hidden analysis; one retry when the answer is not parseable JSON. */
export async function runTeamAnalysis(input: TeamPromptInput, run: TeamRunner): Promise<TeamResponse> {
  return runJsonPrompt(buildTeamPrompt(input), run);
}

/** Drafts ONE agent from a free-text description. More than one agent in the
 *  answer is trimmed to the first; none at all is an error. */
export async function runAgentDraft(input: AgentDraftInput, run: TeamRunner): Promise<TeamResponse> {
  const r = await runJsonPrompt(buildAgentDraftPrompt(input), run);
  if (r.kind === 'questions') return { kind: 'error', error: 'expected an agent, got questions' };
  if (r.kind === 'agents') {
    if (r.agents.length === 0) {
      const why = r.invalid[0]?.errors.join('; ');
      return { kind: 'error', error: why ? `invalid agent: ${why}` : 'no agent in the response' };
    }
    return { ...r, agents: r.agents.slice(0, 1) };
  }
  return r;
}

async function runJsonPrompt(prompt: string, run: TeamRunner): Promise<TeamResponse> {
  let last: TeamResponse = { kind: 'error', error: 'no response' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await run(attempt === 0 ? prompt : prompt + RETRY_SUFFIX);
    if (!r.ok || !r.text) {
      last = { kind: 'error', error: r.error ?? 'no response' };
      // A cancelled/timed-out run is not a formatting problem: do not retry.
      if (!r.ok) return last;
      continue;
    }
    const parsed = parseTeamResponse(r.text);
    if (parsed.kind !== 'error') return parsed;
    last = parsed;
  }
  return last;
}

/** Caps on what the renderer may send to the team:* IPC handlers. */
export const TEAM_INPUT_CAPS = {
  existingAgents: 50,
  answers: 3,
  answerChars: 2000,
  analysisChars: 6000,
  manifests: TEAM_SIZE.max,
  scope: MAX_SCOPE
} as const;

/** Untrusted renderer input → a bounded TeamPromptInput for `repoRoot` (the
 *  sender's bound floor repo, never the path the renderer sent). */
export function sanitizeTeamInput(
  raw: unknown,
  repoRoot: string,
  defaultModel?: string,
  allowedScope?: ReadonlySet<string>
): TeamPromptInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const C = TEAM_INPUT_CAPS;
  const o = raw as Partial<TeamPromptInput>;
  const round = o.round === 2 ? 2 : 1;
  const existingAgents = Array.isArray(o.existingAgents)
    ? o.existingAgents
        .filter((a): a is { name: string; description?: string } => !!a && typeof a.name === 'string')
        .slice(0, C.existingAgents)
        .map((a) => ({
          name: a.name.slice(0, 80),
          description: typeof a.description === 'string' ? a.description.slice(0, HIRE_LIMITS.description) : undefined
        }))
    : [];
  const answers = Array.isArray(o.answers)
    ? o.answers
        .filter((a) => !!a && typeof a.question === 'string' && typeof a.answer === 'string')
        .slice(0, C.answers)
        .map((a) => ({ question: a.question.slice(0, C.answerChars), answer: a.answer.slice(0, C.answerChars) }))
    : undefined;
  // Model ids per hire provider: known providers only, capped, id-shaped.
  let models: Record<string, string[]> | undefined;
  if (o.models && typeof o.models === 'object' && !Array.isArray(o.models)) {
    models = {};
    for (const p of HIRE_PROVIDERS) {
      const list = (o.models as Record<string, unknown>)[p];
      if (!Array.isArray(list)) continue;
      const ids = list
        .filter((m): m is string => typeof m === 'string' && /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/.test(m))
        .slice(0, 24);
      if (ids.length > 0) models[p] = ids;
    }
  }
  // Scope: safe relative paths that are known sub-projects, deduped, sorted, capped.
  const scopeList = Array.isArray(o.scope)
    ? [...new Set(o.scope.filter((p): p is string => typeof p === 'string' && isSafeRelPath(p) && (!allowedScope || allowedScope.has(p))))]
        .sort()
        .slice(0, C.scope)
    : [];
  return {
    repoRoot, existingAgents, round, models,
    scope: scopeList.length > 0 ? scopeList : undefined,
    analysis: typeof o.analysis === 'string' ? o.analysis.slice(0, C.analysisChars) : undefined,
    answers,
    defaultModel
  };
}

/** Untrusted renderer input → a bounded AgentDraftInput; the repo is the
 *  sender's bound floor (or null), never a path the renderer sent. */
export function sanitizeAgentDraftInput(raw: unknown, repoRoot: string | null, defaultModel?: string): AgentDraftInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { request?: unknown };
  const request = typeof o.request === 'string' ? o.request.trim().slice(0, MAX_AGENT_REQUEST) : '';
  if (!request) return null;
  // Reuse the team caps for the shared fields (existing agents, model ids).
  const base = sanitizeTeamInput({ ...(raw as object), round: 1 }, repoRoot ?? '', defaultModel);
  if (!base) return null;
  return { repoRoot, request, existingAgents: base.existingAgents, models: base.models, defaultModel };
}

export function hiresDir(home: string, repoRoot: string): string {
  return join(home, 'hires', repoSlug(repoRoot));
}

function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'agent';
}

/** Writes each manifest (revalidated) as `<YYYY-MM-DD>-<slug>.json` strictly
 *  under `<home>/hires/<repoSlug>/`; never overwrites an existing file.
 *  `manifests` lists the validated manifests actually written, aligned with `written`. */
export function writeTeamHires(
  home: string,
  repoRoot: string,
  input: HireManifest[],
  now: Date = new Date()
): { written: string[]; errors: string[]; manifests: HireManifest[] } {
  const written: string[] = [];
  const errors: string[] = [];
  const manifests: HireManifest[] = [];
  const dir = hiresDir(home, repoRoot);
  const day = now.toISOString().slice(0, 10);
  for (const raw of input) {
    const v = validateHireManifest(raw);
    if (!v.ok) {
      const nm = raw && typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name.slice(0, 40) : '?';
      errors.push(`${nm}: ${v.errors.join('; ')}`);
      continue;
    }
    const manifest = v.manifest;
    if (!manifest) { errors.push('invalid manifest'); continue; }
    try {
      mkdirSync(dir, { recursive: true });
      const base = `${day}-${nameSlug(manifest.name)}`;
      let file = join(dir, `${base}.json`);
      for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.json`);
      writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      written.push(file);
      manifests.push(manifest);
    } catch (e) {
      errors.push(`${manifest.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, errors, manifests };
}
