/**
 * Two additions to the Conversation view:
 *
 * - Pending bubbles: a message sent from the composer shows in the thread at
 *   once, even while it waits in the agent's queue, and stays there ("Sending…")
 *   until the transcript has it. Like Claude Code: you see what you sent, the
 *   agent picks it up when it is free.
 * - Reactions: an automatic acknowledgement on your latest message (👀 received,
 *   ✅ handled) and emoji you add yourself to any message, kept on this machine.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type QueuedMessage } from '@/store/store';
import { cleanUserText, type ConversationEntry } from '@shared/conversation';

// ─── Pending (queued / just sent) messages ───────────────────────────────────

const EMPTY_QUEUE: QueuedMessage[] = [];
/** Queue ids the user removed (or cleared): gone, but NOT sent. */
const dismissed = new Set<string>();
export function markQueuedDismissed(ids: readonly string[]): void {
  for (const id of ids) dismissed.add(id);
}

export interface PendingBubble {
  id: string;
  text: string;
  /** queued: still waiting for the agent. sending: typed into the terminal,
   *  not in the transcript yet. */
  state: 'queued' | 'sending';
  manual?: boolean;
}

/** How long a delivered message stays as "Sending…" if the transcript never
 *  shows it (a slash command, a dropped nudge, a session that restarted). */
const SENT_GRACE_MS = 25_000;
const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

interface Sent { id: string; text: string; at: number; afterId: string | null }

function lastSeenId(entries: readonly ConversationEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'user' || e.kind === 'event') return e.id;
  }
  return null;
}

/** True when an entry after `afterId` carries this message's text. */
function landed(entries: readonly ConversationEntry[], s: Sent): boolean {
  const want = squash(cleanUserText(s.text)).slice(0, 80);
  if (!want) return true;
  let start = 0;
  if (s.afterId) {
    const i = entries.findIndex((e) => e.id === s.afterId);
    if (i >= 0) start = i + 1;
  }
  for (let i = start; i < entries.length; i++) {
    const e = entries[i];
    if ((e.kind === 'user' || e.kind === 'event') && squash(e.text).includes(want)) return true;
  }
  return false;
}

/** What the thread should show below the transcript for this agent. Inbox
 *  nudges (they carry a delivery precondition) are plumbing, not shown. */
export function usePendingBubbles(agentId: string, entries: readonly ConversationEntry[]): PendingBubble[] {
  const queue = useStore((s) => s.messageQueues[agentId]) ?? EMPTY_QUEUE;
  const prevRef = useRef<{ agentId: string; queue: QueuedMessage[] }>({ agentId, queue });
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [sent, setSent] = useState<Sent[]>([]);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { agentId, queue };
    if (prev.agentId !== agentId) { setSent([]); return; }
    const still = new Set(queue.map((m) => m.id));
    const gone = prev.queue.filter((m) => !still.has(m.id) && !dismissed.has(m.id) && !m.precondition);
    if (!gone.length) return;
    const afterId = lastSeenId(entriesRef.current);
    const at = Date.now();
    setSent((s) => [...s, ...gone.map((m) => ({ id: m.id, text: m.text, at, afterId }))]);
  }, [agentId, queue]);

  // Drop a sent message once the transcript shows it, or after the grace period.
  useEffect(() => {
    if (!sent.length) return;
    const prune = () => setSent((s) => {
      const now = Date.now();
      const keep = s.filter((m) => now - m.at < SENT_GRACE_MS && !landed(entriesRef.current, m));
      return keep.length === s.length ? s : keep;
    });
    prune();
    const iv = setInterval(prune, 1500);
    return () => clearInterval(iv);
  }, [sent.length, entries]);

  return [
    ...sent.map((m): PendingBubble => ({ id: m.id, text: m.text, state: 'sending' })),
    ...queue.filter((m) => !m.precondition).map((m): PendingBubble => ({
      id: m.id, text: m.text, state: 'queued', manual: m.manual
    }))
  ];
}

/** Poll the floor-wide auto-delivery pause (main-process control state) while
 * this agent has messages waiting. 2s is plenty — the pause flips on human
 * timescales, and the drain re-reads the live snapshot before every send. */
export function useDeliveryPaused(agentId: string, active: boolean): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId, active]);
  return paused;
}

/** The status line under a pending bubble: queued (remove / send now) or sending. */
export function PendingStatus({ agentId, bubble, paused }: { agentId: string; bubble: PendingBubble; paused: boolean }) {
  const { t } = useTranslation();
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const releaseQueuedMessage = useStore((s) => s.releaseQueuedMessage);
  const link: React.CSSProperties = {
    border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
    font: 'inherit', color: 'var(--cth-ink-500)', textDecoration: 'underline'
  };
  return (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8,
      marginTop: 3, fontSize: '0.8em', color: 'var(--cth-ink-500)'
    }}>
      {bubble.state === 'sending' ? (
        <span>{t('conversation.sending')}</span>
      ) : (
        <>
          <span className="cth-pending-dot" aria-hidden />
          <span>{t('conversation.queued')}</span>
          {paused && !bubble.manual && (
            <button type="button" style={link} onClick={() => releaseQueuedMessage(agentId, bubble.id)}>
              {t('conversation.sendNow')}
            </button>
          )}
          <button type="button" style={link} onClick={() => {
            markQueuedDismissed([bubble.id]);
            removeQueuedMessage(agentId, bubble.id);
          }}>
            {t('conversation.removeQueued')}
          </button>
        </>
      )}
    </div>
  );
}

// ─── Reactions ───────────────────────────────────────────────────────────────

export const REACTION_CHOICES = ['👍', '✅', '👀', '❤️', '🎉', '🙏', '😂', '🤔'];
const REACT_KEY = 'cth.conversationReactions';
const MAX_REACTED = 3000;
const NONE: string[] = [];

function loadReactions(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(REACT_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v as Record<string, string[]> : {};
  } catch { return {}; }
}
let reactions = loadReactions();
const reactionListeners = new Set<() => void>();

export function toggleReaction(key: string, emoji: string): void {
  const cur = reactions[key] ?? NONE;
  const nextList = cur.includes(emoji) ? cur.filter((e) => e !== emoji) : [...cur, emoji];
  const next = { ...reactions };
  if (nextList.length) next[key] = nextList; else delete next[key];
  const keys = Object.keys(next);
  if (keys.length > MAX_REACTED) for (const k of keys.slice(0, keys.length - MAX_REACTED)) delete next[k];
  reactions = next;
  try { localStorage.setItem(REACT_KEY, JSON.stringify(next)); } catch { /* storage off */ }
  for (const l of reactionListeners) l();
}

function useReactions(key: string): string[] {
  return useSyncExternalStore(
    (cb) => { reactionListeners.add(cb); return () => { reactionListeners.delete(cb); }; },
    () => reactions[key] ?? NONE
  );
}

export type Ack = 'seen' | 'done';

/**
 * Wraps a message: its reactions underneath, and a small "add reaction" button
 * that shows on hover. `ack` is the agent's automatic acknowledgement.
 */
export function Reactable({ reactKey, align, ack, children }: {
  reactKey: string; align: 'start' | 'end'; ack?: Ack | null; children: ReactNode;
}) {
  const { t } = useTranslation();
  const mine = useReactions(reactKey);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const chip: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 6px', borderRadius: 11,
    fontSize: 13, lineHeight: 1, background: 'var(--cth-cream-50)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', border: 'none', cursor: 'pointer'
  };
  const ackEmoji = ack === 'seen' ? '👀' : ack === 'done' ? '✅' : null;
  const hasRow = !!ackEmoji || mine.length > 0;

  return (
    <div ref={boxRef} className="cth-react-host" style={{
      position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0,
      ...(align === 'end'
        ? { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '85%' }
        : { alignItems: 'stretch' })
    }}>
      {children}
      {hasRow && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4,
          justifyContent: align === 'end' ? 'flex-end' : 'flex-start'
        }}>
          {ackEmoji && (
            <span
              className={ack === 'seen' ? 'cth-ack-pop' : undefined}
              title={ack === 'seen' ? t('conversation.ackSeen') : t('conversation.ackDone')}
              style={{ ...chip, cursor: 'default' }}
            >{ackEmoji}</span>
          )}
          {mine.map((e) => (
            <button key={e} type="button" title={t('conversation.removeReaction')}
              onClick={() => toggleReaction(reactKey, e)}
              style={{ ...chip, boxShadow: 'inset 0 0 0 1px var(--cth-lilac)' }}
            >{e}</button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="cth-react-add"
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
        title={t('conversation.addReaction')}
        aria-label={t('conversation.addReaction')}
        style={{
          position: 'absolute', top: -8, ...(align === 'end' ? { left: -14 } : { right: 0 }),
          width: 24, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}
      >☺</button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', zIndex: 5, top: 18,
          right: 0,
          display: 'flex', gap: 2, padding: 4, borderRadius: 10,
          background: 'var(--cth-paper-100)', boxShadow: '0 4px 14px rgba(0,0,0,0.18), inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          {REACTION_CHOICES.map((e) => (
            <button key={e} type="button" role="menuitem" className="cth-chat-menuitem"
              onClick={() => { toggleReaction(reactKey, e); setOpen(false); }}
              style={{
                width: 28, height: 28, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 16,
                background: mine.includes(e) ? 'var(--cth-cream-200)' : 'transparent'
              }}
            >{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}
