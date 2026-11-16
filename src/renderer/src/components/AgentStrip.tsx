import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { MemoryPanel } from './MemoryPanel';
import { useStore, type Agent } from '@/store/store';
import { type HarnessConfig } from '@/store/config';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useRtl } from '@/i18n/useDirection';
import { useAgentSendPulses } from '@/hooks/useAgentSendPulses';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
  /** Collapsed: a narrow rail of avatars (status + activity cues only). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const headerButton = {
  width: 22, height: 22, padding: 0, flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer',
  color: 'var(--cth-ink-700)'
} as const;

/** Estimated height of the note editor popover, used to keep it on screen. */
const NOTE_POPOVER_H = 150;
const RESTORE_MENU_MIN_W = 240;

export function AgentStrip({ config, collapsed = false, onToggleCollapsed }: AgentStripProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const reorderAgents = useStore(s => s.reorderAgents);
  const renameAgent = useStore(s => s.renameAgent);
  const setAgentNote = useStore(s => s.setAgentNote);
  // Agents that just routed a hive message → a short "sent" pulse on their row.
  const sendPulses = useAgentSendPulses();
  const recipientLabel = (targets: string[]): string => targets
    .map((id) => id === 'human' ? t('agentCard.toHuman') : (agents.find((x) => x.id === id)?.name ?? id))
    .join(', ');
  // Shared with the fullscreen roster so both show one restore in progress.
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  // ONE restore control (bottom of the column): a button whose dropdown OPENS
  // UPWARD and lists last session's agents with per-agent dismiss. The menu is
  // position: fixed (anchored off the button's rect) because the column scrolls
  // — an absolute child would be clipped.
  const [restoreMenuOpen, setRestoreMenuOpen] = useState(false);
  const [restoreMenuPos, setRestoreMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const restoreBtnRef = useRef<HTMLSpanElement>(null);
  const restoreBusy = restoring || autoRestoring;
  useEffect(() => {
    if (restorableAgents.length === 0 || restoreBusy) setRestoreMenuOpen(false);
  }, [restorableAgents.length, restoreBusy]);
  const toggleRestoreMenu = (anchor: HTMLElement | null) => {
    if (restoreMenuOpen) { setRestoreMenuOpen(false); return; }
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    setRestoreMenuPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - RESTORE_MENU_MIN_W - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 6)
    });
    setRestoreMenuOpen(true);
  };
  // Drag-to-reorder the roster: dragId = the card being dragged, overId = the card
  // currently hovered as a drop target (drives the insertion-line cue).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Note editing is EXPLICIT (✎ toggles the editor) — nothing appears on hover.
  // The editor is a fixed popover to the RIGHT of the card (anchored off its
  // rect): the column clips overflow and the cards have no room for an inline box.
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Each worker's actively-DOING ledger tasks, polled from hive/tasks.json —
  // rendered as a sticky note on the avatar card (click → task detail).
  const [doingByAgent, setDoingByAgent] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: string; status?: string; assignee?: string }> } | null;
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const t of (raw && Array.isArray(raw.tasks)) ? raw.tasks : []) {
          if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
            (map[t.assignee] = map[t.assignee] ?? []).push(t.id);
          }
        }
        setDoingByAgent(map);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      // Side column surface (Orca: #171717 dark / #fafafa light). The selected
      // row uses cream-200, which must stay visible against this.
      background: 'var(--cth-paper-100)'
    }}>
      {/* Header: "Agents · N" + collapse toggle + a quick add. Collapsed, only
          the toggle remains. */}
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between', gap: 4,
        padding: collapsed ? '10px 0 6px' : '10px 8px 6px 12px', flexShrink: 0
      }}>
        {!collapsed && (
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600,
            color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis'
          }}>
            {t('agentStrip.header', { count: agents.length })}
          </span>
        )}
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            title={collapsed ? t('agentStrip.expand') : t('agentStrip.collapse')}
            aria-label={collapsed ? t('agentStrip.expand') : t('agentStrip.collapse')}
            aria-expanded={!collapsed}
            className="cth-titlebar-nodrag"
            style={headerButton}
          >
            <Icon name="sidebar" />
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => setAddAgentOpen(true)}
            title={t('agentStrip.addAgent')}
            aria-label={t('agentStrip.addAgent')}
            className="cth-titlebar-nodrag"
            style={headerButton}
          >
            <Icon name="plus" />
          </button>
        )}
      </div>

      {/* Scrollable card list — only this part scrolls; the bottom controls stay put. */}
      <div style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: collapsed ? '4px 6px 12px' : '4px 8px 12px'
      }}>
      {agents.map(a => (
        // Draggable wrapper: reorder the roster by dragging one card onto another.
        // Native HTML5 DnD (no dep). A plain click still selects — a drag only
        // starts on movement — so AgentCard's onClick is unaffected.
        <div
          key={a.id}
          ref={(el) => { cardRefs.current[a.id] = el; }}
          draggable
          onDragStart={(e) => { setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => {
            if (!dragId || dragId === a.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overId !== a.id) setOverId(a.id);
          }}
          onDragLeave={() => { if (overId === a.id) setOverId(null); }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== a.id) reorderAgents(dragId, a.id);
            setDragId(null);
            setOverId(null);
          }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          style={{
            position: 'relative',
            flexShrink: 0,
            width: '100%',
            cursor: 'grab',
            opacity: dragId === a.id ? 0.4 : 1,
            // Insertion-line cue on the hovered drop target (a line on its top edge).
            boxShadow: overId === a.id && dragId && dragId !== a.id
              ? 'inset 0 3px 0 0 var(--cth-ink-900)'
              : 'none',
            transition: 'opacity 120ms ease'
          }}
        >
          <AgentCard
            draggable
            name={a.name}
            accent={a.accent}
            status={a.status}
            ptyId={a.ptyId}
            project={a.project}
            action={a.action}
            progress={a.progress}
            contextTokens={a.contextTokens}
            contextLimit={a.contextLimit}
            selected={a.id === selectedId}
            isGod={a.isGod}
            onClick={() => select(a.id)}
            onRename={(name) => renameAgent(a.id, name)}
            doingCount={doingByAgent[a.id]?.length ?? 0}
            onTaskNoteClick={() => {
              const first = doingByAgent[a.id]?.[0];
              if (first) openTaskDetail(first);
            }}
            note={a.note}
            onEditNote={() => setNoteEditId(a.id)}
            compact={collapsed}
            sending={sendPulses[a.id]
              ? { key: sendPulses[a.id].key, toLabel: recipientLabel(sendPulses[a.id].targets), subject: sendPulses[a.id].subject }
              : undefined}
          />
          {/* The note itself lives INSIDE the card (its own row above the gauge).
              This is the transient EDITOR: a fixed popover to the RIGHT of the
              card — the card has no room for an inline box, and the column
              clips overflow. ✎ opens it; Esc / ✕ / click-away closes. */}
          {noteEditId === a.id && !dragId && !collapsed && (() => {
            const rect = cardRefs.current[a.id]?.getBoundingClientRect();
            if (!rect) return null;
            const width = 280;
            const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8));
            const top = Math.max(8, Math.min(rect.top, window.innerHeight - NOTE_POPOVER_H - 8));
            return (
              <>
                {/* click-away backdrop */}
                <div
                  onClick={() => setNoteEditId(null)}
                  style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
                />
                <div
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: 'fixed', left, top, width, zIndex: 350,
                    padding: 10, boxSizing: 'border-box',
                    background: 'var(--cth-paper-100)',
                    border: '1px solid var(--cth-ink-300)', borderRadius: 'var(--cth-radius-lg)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
                    display: 'flex', flexDirection: 'column', gap: 6
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '16px',
                      color: 'var(--cth-ink-500)'
                    }}>{t('agentStrip.privateNote', { name: a.name })}</span>
                    <button
                      onClick={() => setNoteEditId(null)}
                      title={t('agentStrip.done')}
                      aria-label={t('agentStrip.closeNoteEditor')}
                      style={{
                        flexShrink: 0, width: 18, height: 18, padding: 0, lineHeight: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                        color: 'var(--cth-ink-500)', background: 'transparent',
                        border: 'none', cursor: 'pointer'
                      }}
                    >✕</button>
                  </div>
                  {/* A textarea, not an input: the note is a bullet list (one
                      line per bullet) and the fullscreen roster renders every
                      line — an <input> would silently eat the newlines. */}
                  <textarea
                    dir={rtl ? 'auto' : undefined}
                    autoFocus
                    rows={3}
                    value={a.note ?? ''}
                    onChange={(e) => setAgentNote(a.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setNoteEditId(null); }}
                    placeholder={t('agentStrip.notePlaceholder')}
                    aria-label={t('agentCard.noteAria', { name: a.name })}
                    style={{
                      width: '100%', padding: '6px 8px',
                      border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box',
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                      lineHeight: '18px', color: 'var(--cth-ink-900)'
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                    {t('agentStrip.oneLineOneBullet')}
                  </span>
                </div>
              </>
            );
          })()}
        </div>
      ))}
      </div>

      {/* Collapsed: the bottom controls shrink to icon buttons. */}
      {collapsed && (
        <div style={{
          marginTop: 'auto', flexShrink: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          padding: '8px 0 12px',
          borderTop: '1px solid var(--cth-ink-100)'
        }}>
          <button
            type="button"
            onClick={() => setAddAgentOpen(true)}
            title={t('agentStrip.addAgent')}
            aria-label={t('agentStrip.addAgent')}
            className="cth-titlebar-nodrag"
            style={{ ...headerButton, width: 30, height: 30, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}
          >
            <Icon name="plus" />
          </button>
          {(restorableAgents.length > 0 || restoreBusy) && (
            <span ref={restoreBtnRef} style={{ display: 'inline-flex' }}>
              <button
                type="button"
                disabled={restoreBusy}
                onClick={() => toggleRestoreMenu(restoreBtnRef.current)}
                title={restoreBusy
                  ? t('agentStrip.restoringTeam')
                  : t('agentStrip.restoreTeam', { count: restorableAgents.length })}
                aria-label={t('agentStrip.restoreTeam', { count: restorableAgents.length })}
                className="cth-titlebar-nodrag"
                style={{
                  ...headerButton, width: 30, height: 30,
                  background: 'var(--cth-ink-900)', color: 'var(--cth-paper-100)',
                  opacity: restoreBusy ? 0.5 : 1, cursor: restoreBusy ? 'default' : 'pointer'
                }}
              >
                <Icon name="play" />
              </button>
            </span>
          )}
        </div>
      )}

      {/* Bottom controls, pinned below the scroll area: add agent + restore team + memory. */}
      {!collapsed && (
      <div style={{
        marginTop: 'auto', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '10px 12px 12px',
        borderTop: '1px solid var(--cth-ink-100)'
      }}>
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ width: '100%' }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <Icon name="plus" /> {t('agentStrip.addAgent')}
        </span>
      </PixelButton>
      {/* ONE restore control, pinned to the strip's right edge. Busy (manual OR
          boot auto-restore) collapses to a single disabled "restoring your
          team…"; otherwise the button opens an upward dropdown listing last
          session's agents (per-agent ✕ dismiss + restore all). No outcome note
          is rendered afterwards — the restored agents appearing IS the outcome. */}
      {(restorableAgents.length > 0 || restoreBusy) && (
        <span
          ref={restoreBtnRef}
          style={{ display: 'block', width: '100%' }}
          title={restoreBusy
            ? t('agentStrip.restoringTitle')
            : t('agentStrip.restoreTitle', { names: restorableAgents.map((a: Agent) => a.name).join(', ') })}
        >
          <PixelButton
            variant="primary"
            size="lg"
            style={{ width: '100%' }}
            disabled={restoreBusy}
            onClick={() => toggleRestoreMenu(restoreBtnRef.current)}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <Icon name="play" />
              {restoreBusy ? t('agentStrip.restoringTeam') : t('agentStrip.restoreTeam', { count: restorableAgents.length })}
            </span>
          </PixelButton>
        </span>
      )}
      {/* Memory pill — opens the memory panel over the right zone. Kept here so
          it never covers the terminal's composer when closed. */}
      <MemoryPanel />
      </div>
      )}
      {restoreMenuOpen && restoreMenuPos && restorableAgents.length > 0 && (
        <>
          {/* click-away backdrop */}
          <div
            onClick={() => setRestoreMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
          />
          <div style={{
            position: 'fixed', left: restoreMenuPos.left, bottom: restoreMenuPos.bottom,
            zIndex: 350, minWidth: RESTORE_MENU_MIN_W, maxHeight: '50vh', overflowY: 'auto',
            background: 'var(--cth-cream-50)',
            border: '1px solid var(--cth-ink-300)', borderRadius: 'var(--cth-radius-lg)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
            padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
            fontFamily: 'var(--cth-font-ui)'
          }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '16px',
              color: 'var(--cth-ink-500)'
            }}>
              {t('agentStrip.previousSession')}
            </span>
            {/* Per-agent dismiss wires straight to removeRestorableAgent
                (filters + persistRestorable), so a dismissed agent never
                reappears after reload. */}
            {restorableAgents.map((a: Agent) => (
              <span
                key={a.id}
                title={t('agentStrip.restorable', { name: a.name })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 26, padding: '0 4px 0 8px',
                  fontSize: 12, color: 'var(--cth-ink-900)',
                  background: 'var(--cth-paper-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </span>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
                  {a.description ? a.description.slice(0, 24) : ''}
                </span>
                <button
                  onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                  title={t('agentStrip.dismiss', { name: a.name })}
                  aria-label={t('agentStrip.dismissAria', { name: a.name })}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, padding: 0, lineHeight: 1,
                    fontSize: 12, color: 'var(--cth-ink-500)',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                  }}
                >✕</button>
              </span>
            ))}
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => { setRestoreMenuOpen(false); void restoreTeam(); }}
            >
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                <Icon name="play" /> {t('agentStrip.restoreAll', { count: restorableAgents.length })}
              </span>
            </PixelButton>
          </div>
        </>
      )}
    </div>
  );
}
