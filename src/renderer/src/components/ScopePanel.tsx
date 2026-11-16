import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, floorRepo } from '@/store/store';
import { MAX_SCOPE } from '@shared/scopeLimits';
import { applyFloorScope } from '@/store/scopeActions';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import {
  countOpenTasks, planScopeSwitch, sameScope, splitMissing, type Subproject
} from '@/components/scopeFlow';

type Confirm = { ids: string[]; names: { name: string; busy: boolean }[]; openTasks: number | null };

/** « Périmètre » panel: monorepo toggle + sub-project selection of the floor. */
export function ScopePanel({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.floorScope) ?? { enabled: false, scope: [] };
  const [enabled, setEnabled] = useState(current.enabled);
  const [selected, setSelected] = useState<string[]>(current.scope);
  const [items, setItems] = useState<Subproject[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (refresh: boolean) => {
    setLoading(true);
    try {
      const r = await window.cth.floorSubprojects(refresh);
      setItems(r.items);
      setTruncated(r.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  // First open uses main's cache; « Rafraîchir » rescans.
  useEffect(() => { void load(false); }, []);

  const target = { enabled, scope: enabled ? selected : [] };
  const changed = target.enabled !== current.enabled || !sameScope(target.scope, current.scope);
  const { missing } = splitMissing(selected, items);
  const tooMany = enabled && selected.length > MAX_SCOPE;

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = new Map<string, Subproject[]>();
    for (const it of items) {
      if (q && !it.path.toLowerCase().includes(q) && !it.label.toLowerCase().includes(q)) continue;
      out.set(it.group, [...(out.get(it.group) ?? []), it]);
    }
    return [...out.entries()];
  }, [items, filter]);

  const toggle = (path: string, on: boolean) =>
    setSelected((s) => (on ? [...s.filter((p) => p !== path), path] : s.filter((p) => p !== path)));

  const run = async (ids: string[]) => {
    setBusy(true);
    setError('');
    const r = await applyFloorScope(target, ids);
    setBusy(false);
    if (r.ok) { onClose(); return; }
    setConfirm(null);
    if (r.stale) {
      // The floor changed under the confirmation: show the new team, never auto-run.
      const plan = planScopeSwitch(useStore.getState().agents);
      if (plan.needsConfirm) void askConfirm(plan);
      setError("L'équipe a changé : vérifie la liste avant de confirmer.");
    } else {
      setError(r.error);
    }
  };

  const apply = () => {
    const plan = planScopeSwitch(useStore.getState().agents);
    if (sameScope(target.scope, current.scope) || !plan.needsConfirm) { void run(plan.toPark.map((a) => a.id)); return; }
    void askConfirm(plan);
  };

  const askConfirm = async (plan: ReturnType<typeof planScopeSwitch>) => {
    const ids = plan.toPark.map((a) => a.id);
    const busyIds = new Set(plan.busy.map((a) => a.id));
    const names = [...plan.busy, ...plan.toPark.filter((a) => !busyIds.has(a.id))]
      .map((a) => ({ name: a.name, busy: busyIds.has(a.id) }));
    setConfirm({ ids, names, openTasks: null });
    try {
      const n = countOpenTasks(await window.cth.hiveTasks(), plan.toPark.map((a) => a.id));
      setConfirm((c) => (c ? { ...c, openTasks: n } : c));
    } catch { /* count stays hidden */ }
  };

  const closeRef = useRef(onClose);
  closeRef.current = busy ? () => {} : onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const repo = (floorRepo ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

  return (
    <div style={overlayStyle}>
      <div style={{ width: 640, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title={`Périmètre — ${repo}`} noPadding>
          <label style={{ position: 'absolute', top: 9, right: 14, display: 'flex', alignItems: 'center', gap: 6, ...textStyle }}>
            <input type="checkbox" checked={enabled} disabled={busy || !!confirm} onChange={(e) => setEnabled(e.target.checked)} />
            Monorepo
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, maxHeight: '80vh', overflowY: 'auto' }}>
            {confirm ? (
              <ConfirmPark confirm={confirm} />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="filtrer…"
                    disabled={!enabled}
                    style={inputStyle}
                  />
                  <PixelButton variant="secondary" size="sm" disabled={loading} onClick={() => void load(true)}>
                    Rafraîchir
                  </PixelButton>
                </div>
                <div style={{ opacity: enabled ? 1 : 0.5, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {loading && <span style={mutedStyle}>Recherche des sous-projets…</span>}
                  {!loading && items.length === 0 && <span style={mutedStyle}>Aucun sous-projet détecté.</span>}
                  {groups.map(([group, list]) => (
                    <div key={group}>
                      <div style={{ ...mutedStyle, marginBottom: 4 }}>{group || '(racine)'}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
                        {list.map((it) => (
                          <label key={it.path} title={it.path} style={{ display: 'flex', alignItems: 'center', gap: 6, ...textStyle }}>
                            <input
                              type="checkbox"
                              disabled={!enabled || busy}
                              checked={selected.includes(it.path)}
                              onChange={(e) => toggle(it.path, e.target.checked)}
                            />
                            <span style={ellipsis}>{it.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  {missing.map((p) => (
                    <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, ...textStyle }}>
                      <input type="checkbox" checked disabled={!enabled || busy} onChange={() => toggle(p, false)} />
                      <s style={{ color: 'var(--cth-ink-500)' }}>{p}</s>
                      <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>introuvable</span>
                    </label>
                  ))}
                  {truncated && <span style={mutedStyle}>Liste tronquée : trop de sous-projets.</span>}
                </div>
              </>
            )}
            {tooMany && !confirm && (
              <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>
                {`Au plus ${MAX_SCOPE} sous-projets par périmètre (${selected.length} cochés).`}
              </span>
            )}
            {error && <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{error}</span>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <PixelButton variant="secondary" size="md" disabled={busy} onClick={confirm ? () => setConfirm(null) : onClose}>
                Annuler
              </PixelButton>
              {confirm ? (
                <PixelButton variant="primary" size="md" disabled={busy} onClick={() => void run(confirm.ids)}>
                  {busy ? 'Mise de côté…' : 'Mettre de côté et appliquer'}
                </PixelButton>
              ) : (
                <PixelButton variant="primary" size="md" disabled={!changed || busy || tooMany} onClick={apply}>
                  {busy ? 'Application…' : 'Appliquer'}
                </PixelButton>
              )}
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function ConfirmPark({ confirm }: { confirm: Confirm }) {
  const n = confirm.names.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, ...textStyle }}>
        {n > 1 ? `Ces ${n} agents quittent l'étage :` : 'Cet agent quitte l\'étage :'}
      </p>
      <ul style={{ margin: 0, paddingInlineStart: 18, ...textStyle }}>
        {confirm.names.map((a, i) => (
          <li key={i}>
            {a.name}
            {a.busy && <span style={{ marginInlineStart: 6, fontSize: 12, color: 'var(--cth-danger)' }}>en cours</span>}
          </li>
        ))}
      </ul>
      {!!confirm.openTasks && (
        <p style={{ margin: 0, ...mutedStyle }}>
          {confirm.openTasks > 1
            ? `${confirm.openTasks} tâches ouvertes leur sont assignées ; elles restent telles quelles.`
            : '1 tâche ouverte leur est assignée ; elle reste telle quelle.'}
        </p>
      )}
      <p style={{ margin: 0, ...textStyle }}>
        Ces agents sont mis de côté avec leur conversation et leur worktree. Tu pourras reprendre cette équipe.
      </p>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500
};
const textStyle: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' };
const mutedStyle: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)' };
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const inputStyle: CSSProperties = {
  flex: 1, padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  borderRadius: 'var(--cth-radius-sm)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
};
