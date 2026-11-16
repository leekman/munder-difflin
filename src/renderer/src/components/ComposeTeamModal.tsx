import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, floorRepo } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { HIRE_LIMITS, HIRE_PROVIDERS, type HireManifest, type HireProvider } from '@shared/hire';
import { parseTeamResponse, TEAM_SIZE, type TeamResponse } from '@shared/teamPrompt';
import { effortFor, effortLevelsFor, type EffortLevel } from '@shared/effort';
import { modelsForProvider } from '@/store/config';
import type { AgentProvider } from '@shared/agentProvider';
import {
  analysisScope,
  cardsFromResponse,
  existingAgentsOf,
  modelIdsByProvider,
  nextStep,
  prepareWrite,
  workdirOptions,
  type ComposeCard,
  type ComposeStep
} from '@/components/composeTeamFlow';
import { localSummary, remembersTeams, type Subproject } from '@/components/scopeFlow';

type Tab = 'auto' | 'manual';
type WriteResult = { written: string[]; errors: string[]; manifests: HireManifest[] };

/**
 * "Compose the team": a read-only analysis of the floor's repo proposes a team
 * of agents (automatic, via a hidden Claude run — or manual, by copying the
 * prompt into any assistant and pasting its answer). The edited proposal is
 * written as hire@1 files; nothing spawns from here — "Import now" queues the
 * written manifests into AddAgentModal's review.
 *
 * On a monorepo floor the analysis is limited to the floor's scope (missing
 * sub-projects dropped), each card picks its `workdir` among the scope, and the
 * written team is remembered for that scope (summary now, agents when parked).
 * Opened in 'scratch' mode (« Repartir de zéro »), the current agents are not
 * shown to the analysis and a new team is always remembered.
 */
export function ComposeTeamModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const enqueuePendingHires = useStore((s) => s.enqueuePendingHires);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const floorScope = useStore((s) => s.floorScope);
  const mode = useStore((s) => s.composeTeamMode);

  const [tab, setTab] = useState<Tab>('auto');
  const [step, setStep] = useState<ComposeStep>('idle');
  const [analysis, setAnalysis] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [cards, setCards] = useState<ComposeCard[]>([]);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [writing, setWriting] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [teamSummary, setTeamSummary] = useState<string | undefined>();
  // Detected sub-projects (labels of the workdir picker, missing scope paths).
  const [subprojects, setSubprojects] = useState<Subproject[]>([]);
  // Non-blocking: the team could not be remembered (the files are written).
  const [saveNotice, setSaveNotice] = useState('');

  const scoped = !!floorScope?.enabled && floorScope.scope.length > 0;
  const scopeCheck = analysisScope(floorScope, subprojects);
  // The scope the cards' workdir must belong to (undefined = no constraint).
  const cardScope = scoped && scopeCheck.ok && scopeCheck.scope.length > 0 ? scopeCheck.scope : undefined;
  useEffect(() => {
    if (!scoped) return;
    let alive = true;
    window.cth.floorSubprojects()
      .then((r) => { if (alive) setSubprojects(r.items); })
      .catch(() => { /* labels fall back to paths */ });
    return () => { alive = false; };
  }, [scoped]);

  const repo = floorRepo ?? '';
  // Step to return to when an analysis is cancelled (idle or questions).
  const beforeAnalyzeRef = useRef<ComposeStep>('idle');
  const cancelledRef = useRef(false);
  const analyzingRef = useRef(false);
  analyzingRef.current = step === 'analyzing';

  // Closing the modal mid-analysis must not leave a hidden claude running.
  useEffect(() => () => {
    if (analyzingRef.current && repo) void window.cth.teamCancel(repo);
  }, [repo]);

  /** Scope to analyse, from a fresh sub-project detection: missing paths are
   *  dropped; a scope whose paths are all gone is refused (never widened to
   *  the whole repo). Sets the error and returns null when refused. */
  const resolveScope = async (): Promise<string[] | null> => {
    if (!scoped) return [];
    let items = subprojects;
    try {
      items = (await window.cth.floorSubprojects()).items;
      setSubprojects(items);
    } catch { /* keep the last detection */ }
    const r = analysisScope(floorScope, items);
    if (!r.ok) { setError(r.error); return null; }
    return r.scope;
  };

  const promptInput = (round: 1 | 2, scope: string[]) => ({
    repoRoot: repo,
    // « Repartir de zéro » : the new team is designed without the current one.
    existingAgents: mode === 'scratch' ? [] : existingAgentsOf(agents),
    models: modelIdsByProvider((p) => modelsForProvider(p as AgentProvider)),
    round,
    ...(scope.length > 0 ? { scope } : {}),
    ...(round === 2 ? { analysis, answers: questions.map((q, i) => ({ question: q, answer: answers[i] ?? '' })) } : {})
  });

  const apply = (res: TeamResponse) => {
    const next = nextStep(step, res);
    if (res.kind === 'questions') {
      setAnalysis(res.analysis);
      setQuestions(res.questions);
      setAnswers(res.questions.map(() => ''));
    } else if (res.kind === 'agents') {
      setCards(cardsFromResponse(res, cardScope));
      setTeamSummary(res.teamSummary);
    } else {
      setError(res.error);
    }
    setStep(next);
  };

  const analyze = async (round: 1 | 2) => {
    if (!repo) return;
    setError('');
    const scope = await resolveScope();
    if (!scope) return;
    beforeAnalyzeRef.current = step === 'questions' ? 'questions' : 'idle';
    cancelledRef.current = false;
    setStep('analyzing');
    let res: TeamResponse;
    try {
      res = await window.cth.teamAnalyze(promptInput(round, scope));
    } catch (e) {
      res = { kind: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (cancelledRef.current) { setStep(beforeAnalyzeRef.current); return; }
    apply(res);
  };

  const cancelAnalysis = () => {
    cancelledRef.current = true;
    if (repo) void window.cth.teamCancel(repo);
  };

  const copyPrompt = async (round: 1 | 2) => {
    setError('');
    const scope = await resolveScope();
    if (!scope) return;
    const text = await window.cth.teamPrompt(promptInput(round, scope));
    if (!text) { setError(t('team.promptFailed')); return; }
    setError('');
    const r = await window.cth.copyToClipboard(text);
    if (!r.ok) { setError(r.error ?? t('team.promptFailed')); return; }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const readPasted = () => {
    const res = parseTeamResponse(pasted);
    // A bad paste keeps the current step (and any typed answers): just say why.
    if (res.kind === 'error') { setError(res.error); return; }
    setError('');
    apply(res);
    setPasted('');
  };

  const restart = () => {
    setStep('idle'); setAnalysis(''); setQuestions([]); setAnswers([]);
    setCards([]); setError(''); setPasted(''); setResult(null);
    setTeamSummary(undefined); setSaveNotice('');
  };

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    restart();
  };

  const updateCard = (i: number, patch: Partial<ComposeCard>) =>
    setCards((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const updateField = (i: number, key: keyof HireManifest, value: unknown) =>
    setCards((cs) => cs.map((c, j) => {
      if (j !== i) return c;
      const manifest = { ...c.manifest } as Record<string, unknown>;
      if (value === '' || value === undefined || value === false) delete manifest[key];
      else manifest[key] = value;
      return { ...c, manifest: manifest as unknown as HireManifest, errors: [] };
    }));

  /** Remember the written team for the floor's scope (summary now, agents at
   *  parking time) and make it the current team. In 'normal' mode an existing
   *  current team is updated (its saved agents and queues kept); 'scratch'
   *  always starts a new one. A failure only shows a notice. */
  const rememberTeam = async (written: HireManifest[]) => {
    const st = useStore.getState();
    const scope = [...(st.floorScope?.scope ?? [])].sort();
    const updateId = mode === 'normal' ? st.currentTeamId : null;
    const prev = updateId ? st.knownTeams.find((t) => t.id === updateId) : undefined;
    try {
      const r = await window.cth.teamsSave({
        ...(updateId ? { id: updateId } : {}),
        scope,
        summary: teamSummary ?? localSummary(written),
        agents: prev?.agents ?? [],
        queues: prev?.queues ?? {}
      });
      if (!r.ok) { setSaveNotice(r.error); return; }
      await useStore.getState().setCurrentTeam(r.team.id);
      useStore.getState().setKnownTeams(await window.cth.teamsList(scope));
    } catch (e) {
      setSaveNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const write = async () => {
    const { manifests, cardErrors } = prepareWrite(cards, cardScope);
    setCards((cs) => cs.map((c, i) => ({ ...c, errors: cardErrors[i] })));
    const blocked = cards.some((c, i) => c.checked && !c.invalid && cardErrors[i].length > 0);
    if (blocked || manifests.length === 0 || manifests.length > TEAM_SIZE.max) return;
    setWriting(true);
    setSaveNotice('');
    let res: WriteResult;
    try {
      res = await window.cth.teamWrite(repo, manifests);
    } catch (e) {
      res = { written: [], errors: [e instanceof Error ? e.message : String(e)], manifests: [] };
    } finally {
      setWriting(false);
    }
    setResult(res);
    setStep('written');
    // Monorepo mode off: as before the scope feature, no team is remembered.
    if (res.manifests.length > 0 && remembersTeams(useStore.getState().floorScope)) void rememberTeam(res.manifests);
  };

  const importNow = () => {
    if (!result || result.manifests.length === 0) return;
    enqueuePendingHires(result.manifests);
    setAddAgentOpen(true);
    onClose();
  };

  const close = () => {
    if (step === 'analyzing') cancelAnalysis();
    onClose();
  };

  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const checkedCount = cards.filter((c) => c.checked && !c.invalid).length;
  const tooMany = checkedCount > TEAM_SIZE.max;
  const tabsLocked = step === 'analyzing' || step === 'proposal' || step === 'written';

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0, 0, 0, 0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 500
    }}>
      <div style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title={t('team.title')} noPadding>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            style={{
              position: 'absolute', top: 8, right: 10,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--cth-ink-500)', padding: 4, display: 'inline-flex'
            }}
          >
            <Icon name="x" />
          </button>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 14,
            padding: 16, maxHeight: '86vh', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['auto', 'manual'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={tabsLocked && id !== tab}
                  onClick={() => switchTab(id)}
                  style={{
                    ...chipStyle,
                    background: id === tab ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
                    boxShadow: id === tab ? 'inset 0 0 0 1px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
                    opacity: tabsLocked && id !== tab ? 0.5 : 1
                  }}
                >
                  {id === 'auto' ? t('team.tabAuto') : t('team.tabManual')}
                </button>
              ))}
            </div>

            {step === 'idle' && tab === 'auto' && (
              <Row>
                <p style={hintStyle}>{t('team.autoHint')}</p>
                <PixelButton variant="primary" onClick={() => void analyze(1)} disabled={!repo}>
                  {t('team.analyze')}
                </PixelButton>
              </Row>
            )}

            {step === 'idle' && tab === 'manual' && (
              <Column>
                <p style={hintStyle}>{t('team.manualHint')}</p>
                <div>
                  <PixelButton variant="secondary" onClick={() => void copyPrompt(1)} disabled={!repo}>
                    {copied ? t('team.copied') : t('team.copyPrompt')}
                  </PixelButton>
                </div>
              </Column>
            )}

            {step === 'analyzing' && (
              <Row>
                <span style={{ ...hintStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="cth-spin" style={spinnerStyle} aria-hidden />
                  {t('team.analyzing')}
                </span>
                <PixelButton variant="secondary" onClick={cancelAnalysis}>{t('team.cancel')}</PixelButton>
              </Row>
            )}

            {step === 'questions' && (
              <Column>
                <p style={hintStyle}>{questions.length ? t('team.questionsHint') : t('team.noQuestions')}</p>
                {questions.map((q, i) => (
                  <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={labelStyle}>{q}</span>
                    <input
                      value={answers[i] ?? ''}
                      onChange={(e) => setAnswers((as) => as.map((a, j) => (j === i ? e.target.value : a)))}
                      style={inputStyle}
                    />
                  </label>
                ))}
                <div>
                  {tab === 'auto' ? (
                    <PixelButton variant="primary" onClick={() => void analyze(2)}>{t('team.continue')}</PixelButton>
                  ) : (
                    <PixelButton variant="secondary" onClick={() => void copyPrompt(2)}>
                      {copied ? t('team.copied') : t('team.copyPrompt2')}
                    </PixelButton>
                  )}
                </div>
              </Column>
            )}

            {tab === 'manual' && (step === 'idle' || step === 'questions') && (
              <Column>
                <span style={labelStyle}>{t('team.pasteLabel')}</span>
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={6}
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12, resize: 'vertical' }}
                />
                <div>
                  <PixelButton variant="primary" onClick={readPasted} disabled={!pasted.trim()}>
                    {t('team.parse')}
                  </PixelButton>
                </div>
              </Column>
            )}

            {step === 'error' && (
              <Column>
                <p style={{ ...hintStyle, color: 'var(--cth-danger)' }}>{t('team.errorTitle')} — {error}</p>
                <div><PixelButton variant="secondary" onClick={restart}>{t('team.restart')}</PixelButton></div>
              </Column>
            )}

            {step !== 'error' && error && (
              <p style={{ ...hintStyle, color: 'var(--cth-danger)' }}>{error}</p>
            )}

            {step === 'proposal' && (
              <Column>
                {cards.length === 0 && <p style={hintStyle}>{t('team.emptyProposal')}</p>}
                {cards.map((c, i) => (
                  <AgentCardEditor
                    key={i}
                    card={c}
                    onToggle={(checked) => updateCard(i, { checked })}
                    onField={(k, v) => updateField(i, k, v)}
                    workdirChoices={cardScope ? workdirOptions(cardScope, subprojects) : undefined}
                  />
                ))}
                {tooMany && <p style={hintStyle}>{t('team.tooMany', { n: checkedCount, max: TEAM_SIZE.max })}</p>}
                <Row>
                  <PixelButton variant="ghost" onClick={restart}>{t('team.restart')}</PixelButton>
                  <PixelButton variant="primary" onClick={() => void write()} disabled={writing || checkedCount === 0 || tooMany}>
                    {t('team.write')}
                  </PixelButton>
                </Row>
              </Column>
            )}

            {step === 'written' && result && (
              <Column>
                <span style={labelStyle}>{t('team.writtenTitle')}</span>
                {result.written.length === 0
                  ? <p style={hintStyle}>{t('team.writtenNone')}</p>
                  : (
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {result.written.map((f) => (
                        <li key={f} style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>{f}</li>
                      ))}
                    </ul>
                  )}
                {result.errors.length > 0 && (
                  <>
                    <span style={{ ...labelStyle, color: 'var(--cth-danger)' }}>{t('team.errorsTitle')}</span>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {result.errors.map((e, i) => (
                        <li key={i} style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{e}</li>
                      ))}
                    </ul>
                  </>
                )}
                {saveNotice && (
                  <p style={hintStyle}>
                    L'équipe n'a pas pu être mémorisée pour ce périmètre ({saveNotice}). Les fiches sont écrites : tu peux quand même les importer.
                  </p>
                )}
                <Row>
                  <PixelButton variant="secondary" onClick={() => void window.cth.teamOpenFolder(repo)}>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <Icon name="folder" /> {t('team.openFolder')}
                    </span>
                  </PixelButton>
                  <PixelButton variant="primary" onClick={importNow} disabled={result.manifests.length === 0}>
                    {t('team.importNow')}
                  </PixelButton>
                </Row>
              </Column>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function AgentCardEditor({ card, onToggle, onField, workdirChoices }: {
  card: ComposeCard;
  onToggle: (checked: boolean) => void;
  onField: (key: keyof HireManifest, value: unknown) => void;
  /** Sub-projects of the scope + racine; absent outside a monorepo scope. */
  workdirChoices?: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const m = card.manifest;
  return (
    <PixelPanel variant={card.checked ? 'active' : 'inset'} style={{ opacity: card.invalid ? 0.75 : 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={card.checked}
            disabled={card.invalid}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
            {m.name}
          </span>
          {card.invalid && <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{t('team.invalidCard')}</span>}
        </label>

        {!card.invalid && (
          <>
            <Field label={t('team.fieldName')} value={m.name ?? ''} max={HIRE_LIMITS.name}>
              <input value={m.name ?? ''} onChange={(e) => onField('name', e.target.value)} style={inputStyle} />
            </Field>
            <Field label={t('team.fieldDescription')} value={m.description ?? ''} max={HIRE_LIMITS.description}>
              <input value={m.description ?? ''} onChange={(e) => onField('description', e.target.value)} style={inputStyle} />
            </Field>
            <Field label={t('team.fieldGoal')} value={m.goal ?? ''} max={HIRE_LIMITS.goal}>
              <textarea
                value={m.goal ?? ''}
                onChange={(e) => onField('goal', e.target.value)}
                rows={4}
                style={{ ...inputStyle, fontSize: 13, resize: 'vertical' }}
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 0.8fr) auto', gap: 10, alignItems: 'end' }}>
              <Field label={t('team.fieldProvider')}>
                <select
                  value={m.provider ?? ''}
                  onChange={(e) => {
                    const next = e.target.value as HireProvider | '';
                    onField('provider', next);
                    // Keep the effort valid for the new CLI (codex has no `max`).
                    onField('effort', effortFor(next || 'claude', m.effort));
                  }}
                  style={inputStyle}
                >
                  <option value="">{t('team.providerDefault')}</option>
                  {HIRE_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label={t('team.fieldModel')} value={m.model ?? ''} max={HIRE_LIMITS.model}>
                {/* A list of the catalog's models for this provider, but free
                    text stays possible (a model newer than the catalog). */}
                <input
                  value={m.model ?? ''}
                  onChange={(e) => onField('model', e.target.value)}
                  list={`team-models-${m.provider || 'claude'}`}
                  placeholder={t('team.modelDefault')}
                  style={inputStyle}
                />
                <datalist id={`team-models-${m.provider || 'claude'}`}>
                  {modelsForProvider((m.provider || 'claude') as AgentProvider)
                    .filter((o) => !!o.id)
                    .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </datalist>
              </Field>
              <Field label={t('team.fieldEffort')}>
                <select
                  value={m.effort ?? ''}
                  onChange={(e) => onField('effort', (e.target.value || undefined) as EffortLevel | undefined)}
                  disabled={effortLevelsFor(m.provider || 'claude').length === 0}
                  title={effortLevelsFor(m.provider || 'claude').length === 0 ? t('team.effortUnsupported') : undefined}
                  style={inputStyle}
                >
                  <option value="">{t('team.effortDefault')}</option>
                  {effortLevelsFor(m.provider || 'claude').map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6, ...labelStyle }}>
                <input type="checkbox" checked={!!m.isolate} onChange={(e) => onField('isolate', e.target.checked)} />
                {t('team.fieldIsolate')}
              </label>
            </div>
            {workdirChoices && (
              <Field label="Sous-projet">
                <select
                  value={workdirChoices.some((o) => o.value === m.workdir) ? m.workdir : ''}
                  onChange={(e) => onField('workdir', e.target.value)}
                  style={inputStyle}
                >
                  {workdirChoices.map((o) => (
                    <option key={o.value} value={o.value} title={o.value || undefined}>{o.label}</option>
                  ))}
                </select>
              </Field>
            )}
            {card.why && <p style={{ ...hintStyle, fontStyle: 'italic' }}>{t('team.why', { why: card.why })}</p>}
          </>
        )}

        {card.errors.length > 0 && (
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {card.errors.map((e, i) => <li key={i} style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{e}</li>)}
          </ul>
        )}
      </div>
    </PixelPanel>
  );
}

function Field({ label, value, max, children }: { label: string; value?: string; max?: number; children: ReactNode }) {
  const { t } = useTranslation();
  const over = max !== undefined && (value ?? '').length > max;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={labelStyle}>{label}</span>
        {max !== undefined && (
          <span style={{ ...labelStyle, color: over ? 'var(--cth-danger)' : 'var(--cth-ink-500)' }}>
            {t('team.counter', { n: (value ?? '').length, max })}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>{children}</div>;
}

function Column({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>;
}

const hintStyle: CSSProperties = {
  margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)'
};

const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
};

const chipStyle: CSSProperties = {
  padding: '4px 10px', border: 'none', borderRadius: 'var(--cth-radius-sm)', cursor: 'pointer',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
};

const spinnerStyle: CSSProperties = {
  width: 12, height: 12, borderRadius: '50%',
  border: '2px solid var(--cth-ink-100)', borderTopColor: 'var(--cth-ink-700)',
  display: 'inline-block'
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  borderRadius: 'var(--cth-radius-sm)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};
