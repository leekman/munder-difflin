/**
 * Chat-style rendering of an agent's Claude Code session, shown in the sidebar's
 * Terminal tab instead of the raw xterm (which stays one click away).
 *
 * Source of truth is the session's JSONL transcript, polled incrementally over
 * `window.cth.agentConversation` (main reads only the appended bytes). The raw
 * PTY keeps running underneath: anything interactive the TUI asks for (a
 * permission prompt, a picker) is answered in the raw view — the banner below
 * points there when the agent is blocked.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { derivePlan, findAgentMentions, foldConversation, type ConversationEntry, type PlanStep } from '@shared/conversation';
import { useStore } from '@/store/store';
import { PixelBadge } from './PixelBadge';
import { AskMeTab } from './AskMeTab';
import { HighlightedText, type CodeKind } from './CodeHighlight';
import { waitsOnHuman, type HiveTask } from './TasksKanban';
import { Icon } from './Icon';
import { CliSpinner } from './CliSpinner';
import { readTerminalScreen, sendTerminalKeys } from './terminalPool';
import { useTerminalFontSize, setTerminalFontSize, getTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE } from './terminalFontSize';
import { detectTerminalMenu, menuKeystrokes, type TerminalMenu } from '@shared/terminalMenu';
import { parseInboxNudge } from '@shared/hiveNudge';
import { AgentChip, InboxNudgeCard } from './InboxMail';
import { PendingStatus, Reactable, useDeliveryPaused, usePendingBubbles, type Ack, type PendingBubble } from './ConversationExtras';

const POLL_MS = 900;
/** Within this many px of the bottom counts as "following" the conversation. */
const STICK_PX = 48;

export interface ConversationViewProps {
  agent: Agent;
  /** Switch the tab to the raw terminal (for prompts the TUI needs answered). */
  onShowRaw: () => void;
}

interface ConvState {
  entries: ConversationEntry[];
  path: string | null;
  offset: number;
  truncated: boolean;
  /** True once the first poll answered (so "nothing yet" is not a flash). */
  loaded: boolean;
}

const INITIAL: ConvState = { entries: [], path: null, offset: -1, truncated: false, loaded: false };

export function ConversationView({ agent, onShowRaw }: ConversationViewProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ConvState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // Poll the transcript. A self-rescheduling timeout, not an interval, so a slow
  // read never stacks requests.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(INITIAL);
    const tick = async () => {
      const cur = stateRef.current;
      try {
        const res = await window.cth.agentConversation(agent.id, cur.offset, cur.path);
        if (!alive) return;
        if (!res) {
          if (!cur.loaded) setState((s) => ({ ...s, loaded: true }));
        } else {
          setState((s) => {
            const fresh = res.reset || res.path !== s.path;
            const base = fresh ? [] : s.entries;
            return {
              entries: foldConversation(base, res.items),
              path: res.path,
              offset: res.offset,
              truncated: fresh ? res.truncated : s.truncated,
              loaded: true
            };
          });
        }
      } catch { /* main busy / window tearing down — try again next tick */ }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [agent.id]);

  const contentRef = useRef<HTMLDivElement>(null);
  /** When the user last clicked inside the thread (expanding a block grows it:
   *  that growth must not yank the view to the bottom). */
  const clickedAtRef = useRef(0);
  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // A new agent (switching windows) always opens at the bottom of its thread.
  useLayoutEffect(() => { followRef.current = true; setAway(false); setUnseen(false); toBottom(); }, [agent.id]);
  const jumpToLatest = () => {
    const el = scrollRef.current;
    followRef.current = true;
    setAway(false);
    setUnseen(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

  // While you follow along, new messages and tool activity keep the view at the
  // bottom. Once you scroll up yourself it stays put, and an arrow (with a dot
  // when something new arrived) brings you back to the latest message.
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const messageCount = useMemo(
    () => state.entries.reduce((n, e) => (e.kind === 'user' || e.kind === 'assistant' ? n + 1 : n), 0),
    [state.entries]
  );
  const lastCountRef = useRef({ agentId: agent.id, count: messageCount });
  useLayoutEffect(() => {
    const last = lastCountRef.current;
    lastCountRef.current = { agentId: agent.id, count: messageCount };
    if (followRef.current) toBottom();
    else if (last.agentId === agent.id && messageCount > last.count) setUnseen(true);
  }, [state.entries, messageCount, agent.id]);

  // Content keeps growing after render (markdown, inbox cards, syntax colouring
  // load asynchronously) and the view can be resized or re-shown (Raw ↔
  // Conversation, the Questions sidebar): stay pinned to the bottom through it.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!followRef.current) return;
      if (Date.now() - clickedAtRef.current < 800) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    followRef.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnseen(false);
  };

  const busy = agent.status === 'working' || agent.status === 'thinking';
  // Shares the raw terminal's zoom (− 12px + / Ctrl+= / Ctrl+-), one notch up:
  // proportional UI text reads smaller than the mono grid at the same size.
  const fontSize = useTerminalFontSize();
  const menu = useTerminalMenu(agent.ptyId);
  const blocks = useMemo(() => groupEntries(state.entries), [state.entries]);
  const plan = useMemo(() => derivePlan(state.entries), [state.entries]);
  const blocked = agent.status === 'blocked' && !menu;
  // What you sent shows at once, even while it waits in the queue.
  const pending = usePendingBubbles(agent.id, state.entries);
  const sending = pending.filter((p) => p.state === 'sending');
  const queued = pending.filter((p) => p.state === 'queued');
  const paused = useDeliveryPaused(agent.id, queued.length > 0);
  // The agent's acknowledgement on your latest message: 👀 while it works on
  // it, ✅ once it answered and went idle.
  const ack = useMemo((): { id: string; ack: Ack } | null => {
    const es = state.entries;
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e.kind !== 'user' || (!e.images && parseInboxNudge(e.text))) continue;
      const replied = es.slice(i + 1).some((x) => x.kind === 'assistant');
      return { id: e.id, ack: busy || !replied ? 'seen' : 'done' };
    }
    return null;
  }, [state.entries, busy]);

  // Follow along when you send something.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pending.length) { followRef.current = true; setAway(false); setUnseen(false); el.scrollTop = el.scrollHeight; }
  }, [pending.length]);

  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-100)', fontFamily: 'var(--cth-font-ui)', fontSize: fontSize + 1
    }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerDown={() => { clickedAtRef.current = Date.now(); }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
      <div
        ref={contentRef}
        style={{
          minHeight: '100%', boxSizing: 'border-box',
          padding: '12px 12px 20px', display: 'flex', flexDirection: 'column', gap: 10
        }}
      >
        {state.truncated && (
          <div style={eventStyle}>{t('conversation.olderHidden')}</div>
        )}
        {state.loaded && state.entries.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 8, textAlign: 'center', color: 'var(--cth-ink-500)',
            fontSize: '1em', padding: 16
          }}>
            <div>{state.path ? t('conversation.empty') : t('conversation.noTranscript')}</div>
            <button type="button" onClick={onShowRaw} style={linkButton}>{t('conversation.showRaw')}</button>
          </div>
        )}
        {blocks.map((b, i) => b.type === 'compact' ? (
          <CompactLine key={b.id} instructions={b.instructions} />
        ) : b.type === 'tools' ? (
          <ToolGroup key={b.id} items={b.items} selfId={agent.id} live={busy && i === blocks.length - 1} />
        ) : (
          <EntryView key={b.entry.id} entry={b.entry} accent={agent.accent} cwd={agent.worktreePath ?? agent.cwd} selfId={agent.id}
            ack={ack?.id === b.entry.id ? ack.ack : null} />
        ))}
        {sending.map((p) => (
          <PendingBubbleView key={p.id} agentId={agent.id} bubble={p} accent={agent.accent} paused={paused} />
        ))}
        {busy && (
          <div role="status" style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.92em',
            color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)'
          }}>
            <CliSpinner />
            {agent.status === 'thinking' ? t('conversation.thinkingNow') : t('conversation.working')}
          </div>
        )}
        {queued.map((p) => (
          <PendingBubbleView key={p.id} agentId={agent.id} bubble={p} accent={agent.accent} paused={paused} />
        ))}
      </div>
      </div>
      {away && (
        <div style={{ position: 'relative', height: 0, flexShrink: 0 }}>
          <button
            type="button"
            className="cth-jump-latest"
            onClick={jumpToLatest}
            title={t('conversation.jumpToLatest')}
            aria-label={t('conversation.jumpToLatest')}
            style={{
              position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', zIndex: 4,
              width: 32, height: 32, borderRadius: 16, border: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.25), inset 0 0 0 1px var(--cth-ink-300)'
            }}
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><Icon name="arrow-right" /></span>
            {unseen && (
              <span style={{
                position: 'absolute', top: 1, right: 1, width: 9, height: 9, borderRadius: 5,
                background: 'var(--cth-coral)', boxShadow: '0 0 0 2px var(--cth-paper-100)'
              }} />
            )}
          </button>
        </div>
      )}
      {plan.length > 0 && <PlanPanel steps={plan} />}
      {menu && agent.ptyId && (
        <TerminalMenuCard key={menu.key} menu={menu} ptyId={agent.ptyId} accent={agent.accent} onShowRaw={onShowRaw} />
      )}
      {blocked && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 1px 0 var(--cth-ink-900)',
          fontSize: '0.92em', color: 'var(--cth-ink-900)', flexShrink: 0
        }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {agent.blockReason?.summary ?? t('conversation.needsInput')}
          </span>
          <button type="button" onClick={onShowRaw} style={{ ...linkButton, fontWeight: 600 }}>
            {t('conversation.answerInTerminal')}
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_AGENTS: Agent[] = [];

/** Live chips for the floor agents a message talks about (or a tool call is
 *  addressed to): name + current status, click to open that agent. */
function AgentMentions({ text, ids, selfId, arrow }: {
  text?: string; ids?: string[]; selfId: string; arrow?: boolean;
}) {
  const agents = useStore((s) => s.agents) ?? EMPTY_AGENTS;
  const archived = useStore((s) => s.archivedAgents) ?? EMPTY_AGENTS;
  const all = [...agents, ...archived];
  const found = ids
    ? ids.map((id) => all.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase()))
        .filter((a): a is Agent => !!a && a.id !== selfId)
    : findAgentMentions(text ?? '', all, selfId);
  const unique = found.filter((a, i) => found.findIndex((b) => b.id === a.id) === i);
  if (!unique.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: arrow ? 0 : 6 }}>
      {unique.map((a) => <AgentChip key={a.id} agent={a} arrow={arrow} />)}
    </div>
  );
}

const MENU_POLL_MS = 400;

/** The selection menu currently on the agent's live terminal screen, if any. */
function useTerminalMenu(ptyId: string | undefined): TerminalMenu | null {
  const [menu, setMenu] = useState<TerminalMenu | null>(null);
  useEffect(() => {
    if (!ptyId) { setMenu(null); return; }
    const check = () => {
      const next = detectTerminalMenu(readTerminalScreen(ptyId));
      setMenu((cur) => {
        if (!next) return null;
        if (cur && cur.key === next.key && cur.selected === next.selected) return cur;
        return next;
      });
    };
    check();
    const timer = setInterval(check, MENU_POLL_MS);
    return () => clearInterval(timer);
  }, [ptyId]);
  return menu;
}

/** A menu the CLI is showing, mirrored as buttons. Clicking moves the TUI's
 *  cursor to that option with arrow keys and presses Enter. */
function TerminalMenuCard({ menu, ptyId, accent, onShowRaw }: {
  menu: TerminalMenu; ptyId: string; accent: Agent['accent']; onShowRaw: () => void;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const choose = async (index: number) => {
    if (sending) return;
    setSending(true);
    try { await sendTerminalKeys(ptyId, menuKeystrokes(menu, index)); }
    finally { setTimeout(() => setSending(false), 1500); }
  };
  return (
    <div className="cth-attn-card" style={{
      flexShrink: 0, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
      background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 1px 0 var(--cth-ink-900)',
      color: 'var(--cth-ink-900)', fontSize: '1em'
    }}>
      <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {menu.question || t('conversation.menuTitle')}
      </div>
      {menu.options.map((o) => (
        <button
          key={o.index}
          type="button"
          disabled={sending}
          onClick={() => void choose(o.index)}
          style={{
            textAlign: 'left', padding: '6px 10px', borderRadius: 6, cursor: sending ? 'default' : 'pointer',
            border: 'none', fontFamily: 'var(--cth-font-ui)', fontSize: '1em', color: 'var(--cth-ink-900)',
            background: o.index === menu.selected ? `var(--cth-${accent}-light)` : 'var(--cth-paper-100)',
            boxShadow: o.index === menu.selected ? 'inset 0 0 0 1px var(--cth-ink-900)' : 'inset 0 0 0 1px var(--cth-ink-300)',
            opacity: sending ? 0.6 : 1, overflowWrap: 'anywhere'
          }}
        >
          {o.number !== undefined ? `${o.number}. ` : ''}{o.label}
        </button>
      ))}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button type="button" disabled={sending} onClick={() => void sendTerminalKeys(ptyId, ['\x1b'])} style={linkButton}>
          {t('conversation.menuEscape')}
        </button>
        <button type="button" onClick={onShowRaw} style={linkButton}>{t('conversation.showRaw')}</button>
      </div>
    </div>
  );
}

const eventStyle: React.CSSProperties = {
  alignSelf: 'stretch', textAlign: 'center', fontSize: '0.85em', color: 'var(--cth-ink-500)',
  fontFamily: 'var(--cth-font-mono)'
};

const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--cth-ink-900)', textDecoration: 'underline', fontSize: '0.92em',
  fontFamily: 'var(--cth-font-ui)'
};

/** Your message, as a bubble on the right. */
function UserBubble({ text, images, accent, dim }: { text: string; images?: number; accent: Agent['accent']; dim?: boolean }) {
  const { t } = useTranslation();
  return (
    <div style={{
      maxWidth: '100%', padding: '8px 12px', borderRadius: 12,
      background: `var(--cth-${accent}-light)`, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      color: 'var(--cth-ink-900)', fontSize: '1em', lineHeight: 1.45,
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', opacity: dim ? 0.7 : undefined
    }}>
      {text}
      {images ? (
        <div style={{ marginTop: text ? 4 : 0, fontSize: '0.85em', color: 'var(--cth-ink-500)' }}>
          {t('conversation.images', { count: images })}
        </div>
      ) : null}
    </div>
  );
}

/** A message you sent that the transcript does not have yet. */
function PendingBubbleView({ agentId, bubble, accent, paused }: {
  agentId: string; bubble: PendingBubble; accent: Agent['accent']; paused: boolean;
}) {
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '85%', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <UserBubble text={bubble.text} accent={accent} dim={bubble.state === 'queued'} />
      <PendingStatus agentId={agentId} bubble={bubble} paused={paused} />
    </div>
  );
}

const EntryView = memo(function EntryView({ entry, accent, cwd, selfId, ack }: {
  entry: ConversationEntry; accent: Agent['accent']; cwd?: string; selfId: string; ack?: Ack | null;
}) {
  const { t } = useTranslation();
  switch (entry.kind) {
    case 'user': {
      // The hive's inbox-wake nudge (`📬 inbox: <ids>`): show who wrote and
      // what about, not the raw message ids.
      const nudgeIds = entry.images ? null : parseInboxNudge(entry.text);
      if (nudgeIds) return <InboxNudgeCard agentId={selfId} ids={nudgeIds} />;
      return (
        <Reactable reactKey={`${selfId}:${entry.id}`} align="end" ack={ack}>
          <UserBubble text={entry.text} images={entry.images} accent={accent} />
        </Reactable>
      );
    }
    case 'assistant':
      return (
        <Reactable reactKey={`${selfId}:${entry.id}`} align="start">
          <div style={{ color: 'var(--cth-ink-900)', fontSize: '1em', lineHeight: 1.5, overflowWrap: 'anywhere', minWidth: 0 }}>
            <MarkdownPreview source={entry.text} variant="card" root={cwd} />
            <AgentMentions text={entry.text} selfId={selfId} />
          </div>
        </Reactable>
      );
    case 'thinking':
      return (
        <Collapsible label={t('conversation.thinking')} muted>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.92em', color: 'var(--cth-ink-500)', fontStyle: 'italic' }}>
            {entry.text}
          </div>
        </Collapsible>
      );
    case 'tool':
      return <ToolRow entry={entry} />;
    case 'event':
      return <div style={eventStyle}>— {entry.text} —</div>;
  }
});

/** One quiet line per compaction; the /compact instructions on hover. */
function CompactLine({ instructions }: { instructions?: string }) {
  const { t } = useTranslation();
  return (
    <div title={instructions} style={{
      ...eventStyle, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0
    }}>
      <span style={{ flex: 1, height: 1, background: 'var(--cth-ink-100)' }} />
      <span style={{ whiteSpace: 'nowrap' }}>{t('conversation.compacted')}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--cth-ink-100)' }} />
    </div>
  );
}

// ─── Grouped tool calls (Claude Code desktop style) ──────────────────────────

type ToolLike = Extract<ConversationEntry, { kind: 'tool' } | { kind: 'thinking' }>;
type Block =
  | { type: 'entry'; entry: ConversationEntry }
  | { type: 'tools'; id: string; items: ToolLike[] }
  | { type: 'compact'; id: string; instructions?: string };

/** A `/compact` command, or one of the markers a compaction writes. */
function compactPart(e: ConversationEntry): { instructions?: string } | null {
  if (e.kind !== 'event') return null;
  if (e.text === 'Context compacted') return {};
  const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(e.text.trim());
  return m ? { instructions: m[1]?.trim() || undefined } : null;
}

/** Consecutive tool calls (and the thinking between them) become one block.
 *  A compaction (its `/compact` command, boundary and summary markers, often
 *  repeated) becomes ONE discreet line. */
function groupEntries(entries: readonly ConversationEntry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const compact = compactPart(e);
    if (compact) {
      const last = out[out.length - 1];
      if (last && last.type === 'compact') last.instructions = compact.instructions ?? last.instructions;
      else out.push({ type: 'compact', id: `c:${e.id}`, instructions: compact.instructions });
      continue;
    }
    if (e.kind === 'tool' || e.kind === 'thinking') {
      const last = out[out.length - 1];
      if (last && last.type === 'tools') last.items.push(e);
      else out.push({ type: 'tools', id: `g:${e.id}`, items: [e] });
    } else {
      out.push({ type: 'entry', entry: e });
    }
  }
  return out;
}

type Verb = 'commands' | 'reads' | 'edits' | 'searches' | 'web' | 'agents' | 'plan' | 'messages' | 'tools';

function verbFor(e: Extract<ConversationEntry, { kind: 'tool' }>): Verb {
  if (e.targets?.length) return 'messages';
  if (e.plan) return 'plan';
  switch (e.name) {
    case 'Bash': case 'BashOutput': case 'KillShell': case 'PowerShell': return 'commands';
    case 'Read': case 'NotebookRead': return 'reads';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'edits';
    case 'Grep': case 'Glob': case 'LS': return 'searches';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Task': case 'Agent': return 'agents';
    case 'TodoRead': case 'TaskList': case 'TaskGet': return 'plan';
    default: return 'tools';
  }
}

const VERB_ORDER: Verb[] = ['commands', 'reads', 'edits', 'searches', 'web', 'agents', 'messages', 'plan', 'tools'];

function ToolGroup({ items, selfId, live }: { items: ToolLike[]; selfId: string; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tools = items.filter((e): e is Extract<ConversationEntry, { kind: 'tool' }> => e.kind === 'tool');
  const counts = new Map<Verb, number>();
  for (const e of tools) counts.set(verbFor(e), (counts.get(verbFor(e)) ?? 0) + 1);
  const parts = VERB_ORDER.filter((v) => counts.has(v)).map((v) => {
    const n = counts.get(v)!;
    return t(n === 1 ? `conversation.group.${v}One` : `conversation.group.${v}Many`, { count: n });
  });
  const joined = parts.join(', ');
  const summary = joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : t('conversation.thinking');
  const pending = tools.some((e) => e.result === undefined);
  const errors = tools.filter((e) => e.isError).length;
  const targets = [...new Set(tools.flatMap((e) => e.targets ?? []))];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="cth-conv-group"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: 'fit-content', maxWidth: '100%', minWidth: 0,
          background: 'none', border: 'none', padding: '2px 6px 2px 2px', borderRadius: 6, cursor: 'pointer',
          textAlign: 'left', fontFamily: 'var(--cth-font-ui)', fontSize: '0.88em', color: 'var(--cth-ink-500)'
        }}
      >
        {pending && live ? <CliSpinner /> : (
          <span style={{ width: 14, textAlign: 'center', flexShrink: 0, color: errors ? 'var(--cth-danger)' : 'var(--cth-ink-300)' }}>
            {errors ? '✕' : '✓'}
          </span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{summary}</span>
        {errors > 0 && (
          <span style={{ color: 'var(--cth-danger)', flexShrink: 0 }}>· {t('conversation.group.errors', { count: errors })}</span>
        )}
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0, fontSize: '0.85em' }}>›</span>
      </button>
      {open && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8, paddingLeft: 10,
          boxShadow: 'inset 1px 0 0 var(--cth-ink-300)', minWidth: 0
        }}>
          {items.map((e) => e.kind === 'tool' ? <ToolRow key={e.id} entry={e} /> : (
            <Collapsible key={e.id} label={t('conversation.thinking')} muted>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.92em', color: 'var(--cth-ink-500)', fontStyle: 'italic', padding: '4px 0 4px 16px' }}>
                {e.text}
              </div>
            </Collapsible>
          ))}
        </div>
      )}
      {targets.length > 0 && <AgentMentions ids={targets} selfId={selfId} arrow />}
    </div>
  );
}

/** One tool call: a muted line, opening onto its full input and result. */
function ToolRow({ entry }: { entry: Extract<ConversationEntry, { kind: 'tool' }> }) {
  const pending = entry.result === undefined;
  const view = toolView(entry);
  return (
    <Collapsible
      muted
      label={
        <>
          <span style={{ fontWeight: 600, color: 'var(--cth-ink-700)', flexShrink: 0 }}>{entry.name}</span>
          {entry.summary && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{entry.summary}</span>
          )}
          <span style={{ marginLeft: 'auto', paddingLeft: 8, flexShrink: 0, color: entry.isError ? 'var(--cth-danger)' : 'var(--cth-ink-300)' }}>
            {pending ? '…' : entry.isError ? '✕' : '✓'}
          </span>
        </>
      }
    >
      <div style={{ paddingLeft: 16 }}>
        {entry.input && <FullPre text={view.inputText} kind={view.inputKind} path={view.path} language={view.inputLanguage} />}
        {entry.result !== undefined && entry.result !== '' && (
          <FullPre text={entry.result} kind="output" path={view.resultPath} color={entry.isError && !entry.result.includes('\x1b[') ? 'var(--cth-danger)' : undefined} />
        )}
      </div>
    </Collapsible>
  );
}

/** How a tool's input and result are coloured. */
function toolView(entry: Extract<ConversationEntry, { kind: 'tool' }>): {
  inputText: string; inputKind: CodeKind; inputLanguage?: string; path?: string; resultPath?: string;
} {
  const fileTool = ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(entry.name);
  const path = fileTool && entry.summary && !entry.summary.includes(' ') ? entry.summary : undefined;
  if (entry.name === 'Bash' || entry.name === 'PowerShell') {
    return { inputText: entry.input.replace(/^\$ /, ''), inputKind: 'code', inputLanguage: entry.name === 'Bash' ? 'shell' : 'powershell' };
  }
  if ((entry.name === 'Edit' || entry.name === 'MultiEdit') && path) {
    return { inputText: entry.input.split('\n').slice(1).join('\n'), inputKind: 'diff', path, resultPath: undefined };
  }
  if (entry.name === 'Write' && path && entry.input.startsWith(path + '\n')) {
    return { inputText: entry.input.slice(path.length + 1), inputKind: 'code', path };
  }
  if (entry.name === 'Read') return { inputText: entry.input, inputKind: 'code', inputLanguage: 'json', resultPath: path };
  return { inputText: entry.input, inputKind: 'code', inputLanguage: entry.input.trimStart().startsWith('{') ? 'json' : undefined };
}

/** A code block capped at 280px, with "show all" to lift the cap. */
function FullPre({ text, color, kind, path, language }: {
  text: string; color?: string; kind: CodeKind; path?: string; language?: string;
}) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const long = text.split('\n').length > 16 || text.length > 1500;
  return (
    <div style={{ position: 'relative' }}>
      <pre style={{ ...preStyle, padding: '8px 0', ...(full ? { maxHeight: 'none' } : {}), ...(color ? { color } : {}) }}>
        <HighlightedText text={text} kind={kind} path={path} language={language} />
      </pre>
      {long && (
        <button type="button" onClick={() => setFull((f) => !f)} style={{ ...linkButton, fontSize: '0.8em', color: 'var(--cth-ink-500)', marginTop: 2 }}>
          {full ? t('conversation.showLess') : t('conversation.showAll')}
        </button>
      )}
    </div>
  );
}

// ─── Plan (the agent's step list) ───────────────────────────────────────────

const PLAN_KEY = 'cth.conversationPlanOpen';

function PlanPanel({ steps }: { steps: PlanStep[] }) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem(PLAN_KEY) !== '0'; } catch { return true; }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try { localStorage.setItem(PLAN_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
  };
  const done = steps.filter((s) => s.status === 'completed').length;
  const current = steps.find((s) => s.status === 'in_progress');
  return (
    <div style={{
      flexShrink: 0, margin: '0 12px 6px', borderRadius: 10, background: 'var(--cth-cream-50)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)', fontSize: '0.92em',
      color: 'var(--cth-ink-900)', overflow: 'hidden'
    }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
          border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--cth-font-ui)', fontSize: '1em', color: 'var(--cth-ink-900)'
        }}
      >
        <span style={{ fontWeight: 600 }}>{t('conversation.plan')}</span>
        <span style={{ color: 'var(--cth-ink-500)' }}>{done}/{steps.length}</span>
        {!open && current && (
          <span style={{ color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            · {current.activeForm ?? current.title}
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--cth-ink-500)', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>›</span>
      </button>
      {open && (
        <ol style={{ listStyle: 'none', margin: 0, padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {steps.map((s) => (
            <li key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
              <StepIcon status={s.status} />
              <span style={{
                minWidth: 0, overflowWrap: 'anywhere',
                color: s.status === 'pending' ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
                textDecoration: s.status === 'completed' ? 'line-through' : 'none',
                textDecorationColor: 'var(--cth-ink-300)',
                fontWeight: s.status === 'in_progress' ? 600 : 400
              }}>
                {s.status === 'in_progress' ? (s.activeForm ?? s.title) : s.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: PlanStep['status'] }) {
  const { t } = useTranslation();
  const label = t(`conversation.step.${status}`);
  if (status === 'in_progress') {
    return <span title={label} style={{ flexShrink: 0, display: 'inline-flex', width: 16, justifyContent: 'center' }}><CliSpinner /></span>;
  }
  const done = status === 'completed';
  return (
    <span title={label} aria-label={label} style={{
      flexShrink: 0, width: 14, height: 14, marginTop: 2, marginInline: 1, borderRadius: '50%',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700,
      background: done ? 'var(--cth-mint)' : 'transparent',
      boxShadow: done ? 'none' : 'inset 0 0 0 1.5px var(--cth-ink-300)',
      color: 'var(--cth-on-accent)'
    }}>{done ? '✓' : ''}</span>
  );
}

const preStyle: React.CSSProperties = {
  margin: '6px 0 0', padding: 8, maxHeight: 280, overflow: 'auto',
  background: 'var(--cth-cream-100)', borderRadius: 6,
  fontFamily: 'var(--cth-font-mono)', fontSize: '0.85em', lineHeight: 1.45,
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--cth-ink-700)'
};

function Collapsible({ label, children, boxed, muted }: {
  label: React.ReactNode; children: React.ReactNode; boxed?: boolean; muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={boxed ? {
      borderRadius: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      background: 'var(--cth-cream-50)', padding: '5px 8px', minWidth: 0
    } : { minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--cth-font-mono)', fontSize: '0.85em',
          color: muted ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)'
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▸</span>
        {label}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

const zoomBtn: React.CSSProperties = {
  minWidth: 18, height: 18, padding: '0 4px', display: 'inline-flex', alignItems: 'center',
  justifyContent: 'center', fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1,
  color: 'var(--cth-ink-700)', background: 'var(--cth-paper-100)',
  border: '1px solid var(--cth-ink-300)', borderRadius: 'var(--cth-radius-sm)', cursor: 'pointer'
};

/** Same text-size control as the raw terminal's header, on the same setting. */
function ZoomControls() {
  const { t } = useTranslation();
  const size = useTerminalFontSize();
  return (
    <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2 }}>
      <button type="button" style={zoomBtn} aria-label={t('conversation.zoomOut')} title={t('conversation.zoomOut')}
        onClick={() => setTerminalFontSize(getTerminalFontSize() - 1)}>−</button>
      <button type="button" style={zoomBtn} title={t('conversation.zoomReset')}
        onClick={() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)}>{size}px</button>
      <button type="button" style={zoomBtn} aria-label={t('conversation.zoomIn')} title={t('conversation.zoomIn')}
        onClick={() => setTerminalFontSize(getTerminalFontSize() + 1)}>+</button>
    </div>
  );
}

/** Two-way switch shown above the Terminal tab body. */
export function TerminalModeSwitch({ mode, onChange, extra }: {
  mode: 'conversation' | 'raw'; onChange: (m: 'conversation' | 'raw') => void; extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const opt = (m: 'conversation' | 'raw', label: string) => (
    <button
      type="button"
      onClick={() => onChange(m)}
      aria-pressed={mode === m}
      style={{
        border: 'none', cursor: 'pointer', padding: '3px 10px', borderRadius: 6,
        fontFamily: 'var(--cth-font-ui)', fontSize: 11,
        background: mode === m ? 'var(--cth-paper-100)' : 'transparent',
        boxShadow: mode === m ? 'inset 0 0 0 1px var(--cth-ink-900)' : 'none',
        color: mode === m ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
      }}
    >{label}</button>
  );
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px',
      background: 'var(--cth-cream-100)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)', flexShrink: 0
    }}>
      <Icon name="terminal" />
      {opt('conversation', t('conversation.modeConversation'))}
      {opt('raw', t('conversation.modeRaw'))}
      {mode === 'conversation' && <ZoomControls />}
      {extra}
    </div>
  );
}

// ─── Questions sidebar (the ASK ME board beside the conversation) ─────────────

const QUESTIONS_KEY = 'cth.conversationQuestions';
const QUESTIONS_WIDTH_KEY = 'cth.conversationQuestionsWidth';
const QUESTIONS_WIDTH = 340;
const QUESTIONS_MIN = 240;
const QUESTIONS_MAX = 900;
/** The conversation keeps at least this much room beside a docked sidebar. */
const CONVERSATION_MIN = 320;

function readQuestionsWidth(): number {
  try {
    const n = Number(localStorage.getItem(QUESTIONS_WIDTH_KEY));
    return Number.isFinite(n) && n >= QUESTIONS_MIN ? Math.min(n, QUESTIONS_MAX) : QUESTIONS_WIDTH;
  } catch { return QUESTIONS_WIDTH; }
}
/** Below this body width the sidebar floats over the conversation instead of
 *  squeezing it. */
const NARROW_PX = 720;

function readQuestionsOpen(): boolean {
  try { return localStorage.getItem(QUESTIONS_KEY) !== '0'; } catch { return true; }
}

/** Number of tasks waiting on the human (same predicate as the ASK ME board). */
export function useOpenQuestionCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = async () => {
      try {
        const raw = await window.cth.hiveTasks();
        const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
          ? (raw as { tasks: HiveTask[] }).tasks : [];
        if (alive) setCount(list.filter((t) => !!t && typeof t === 'object' && waitsOnHuman(t)).length);
      } catch { /* keep last count */ }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled]);
  return count;
}

// ─── Shared mode (conversation / raw), synced across every terminal surface ────

export type TerminalViewMode = 'conversation' | 'raw';
const TERMINAL_MODE_KEY = 'cth.terminalViewMode';
const modeListeners = new Set<() => void>();
let currentMode: TerminalViewMode = (() => {
  try { return localStorage.getItem(TERMINAL_MODE_KEY) === 'raw' ? 'raw' : 'conversation'; } catch { return 'conversation'; }
})();

export function setTerminalViewMode(m: TerminalViewMode): void {
  currentMode = m;
  try { localStorage.setItem(TERMINAL_MODE_KEY, m); } catch { /* storage unavailable */ }
  modeListeners.forEach((l) => l());
}

export function useTerminalViewMode(): TerminalViewMode {
  return useSyncExternalStore(
    (l) => { modeListeners.add(l); return () => { modeListeners.delete(l); }; },
    () => currentMode
  );
}

/** Only Claude Code writes the transcript the conversation view reads. */
export function supportsConversation(agent: Agent): boolean {
  return (agent.provider ?? 'claude') === 'claude';
}

/** Wraps an agent's raw terminal with the Conversation / Raw switch. The raw
 *  terminal stays MOUNTED (just hidden) in conversation mode: its stream feeds
 *  the PTY parser that drives the agent's status, blocked detection and prompt
 *  history. Non-Claude agents get the raw terminal unchanged. */
/** `composer` is the message box: inside the conversation column in
 *  Conversation mode (so it sits in the chat, not under the Questions sidebar),
 *  below the terminal otherwise. */
export function TerminalWithConversation({ agent, raw, composer }: { agent: Agent; raw: ReactNode; composer?: ReactNode }) {
  const mode = useTerminalViewMode();
  const { t } = useTranslation();
  const [questionsOpen, setQuestionsOpenState] = useState<boolean>(readQuestionsOpen);
  const setQuestionsOpen = (v: boolean) => {
    setQuestionsOpenState(v);
    try { localStorage.setItem(QUESTIONS_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
  };
  const canConverse = supportsConversation(agent);
  const questionCount = useOpenQuestionCount(canConverse && mode === 'conversation');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [qWidth, setQWidth] = useState<number>(readQuestionsWidth);
  const qWidthRef = useRef(qWidth);
  qWidthRef.current = qWidth;
  /** Drag the sidebar's left edge: width = distance from pointer to the body's right edge. */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const right = body.getBoundingClientRect().right;
    const max = () => Math.max(QUESTIONS_MIN, Math.min(QUESTIONS_MAX, body.clientWidth - (narrow ? 40 : CONVERSATION_MIN)));
    const move = (ev: PointerEvent) => setQWidth(Math.round(Math.min(max(), Math.max(QUESTIONS_MIN, right - ev.clientX))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      try { localStorage.setItem(QUESTIONS_WIDTH_KEY, String(qWidthRef.current)); } catch { /* storage unavailable */ }
    };
    document.body.style.cursor = 'col-resize';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetWidth = () => {
    setQWidth(QUESTIONS_WIDTH);
    try { localStorage.removeItem(QUESTIONS_WIDTH_KEY); } catch { /* storage unavailable */ }
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) { setNarrow(w < NARROW_PX); setBodyWidth(w); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canConverse]);
  if (!canConverse) {
    return <><div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{raw}</div>{composer}</>;
  }
  const showConversation = mode === 'conversation';
  const showQuestions = showConversation && questionsOpen;
  return (
    <>
      <TerminalModeSwitch
        mode={mode}
        onChange={setTerminalViewMode}
        extra={showConversation ? (
          <button
            type="button"
            onClick={() => setQuestionsOpen(!questionsOpen)}
            aria-pressed={questionsOpen}
            title={t('conversation.questionsToggle')}
            style={{
              marginLeft: 8, border: 'none', cursor: 'pointer', padding: '2px 8px', borderRadius: 6,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)',
              background: questionsOpen ? 'var(--cth-paper-100)' : 'transparent',
              boxShadow: questionsOpen ? 'inset 0 0 0 1px var(--cth-ink-900)' : 'inset 0 0 0 1px var(--cth-ink-300)'
            }}
          >
            {t('conversation.questions')}
            {questionCount > 0 && (
              <span className="cth-attn-badge" style={{
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--cth-coral)', color: 'var(--cth-on-accent)'
              }}>{questionCount}</span>
            )}
          </button>
        ) : null}
      />
      <div ref={bodyRef} style={{
        flex: 1, minHeight: 0, minWidth: 0, display: showConversation ? 'flex' : 'none', position: 'relative'
      }}>
        {showConversation && (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <ConversationView agent={agent} onShowRaw={() => setTerminalViewMode('raw')} />
            </div>
            {composer}
          </div>
        )}
        {showQuestions && (
          <aside
            aria-label={t('conversation.questions')}
            style={{
              width: narrow
                ? `min(${qWidth}px, 92%)`
                : Math.max(QUESTIONS_MIN, Math.min(qWidth, bodyWidth ? bodyWidth - CONVERSATION_MIN : qWidth)),
              flexShrink: 0, minHeight: 0, position: narrow ? 'absolute' : 'relative',
              display: 'flex', flexDirection: 'column',
              background: 'var(--cth-paper-200)', boxShadow: 'inset 1px 0 0 var(--cth-ink-300)',
              ...(narrow ? { position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 5, boxShadow: '-6px 0 16px rgba(0,0,0,0.18), inset 1px 0 0 var(--cth-ink-300)' } : {})
            }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('conversation.questionsResize')}
              title={t('conversation.questionsResize')}
              onPointerDown={startResize}
              onDoubleClick={resetWidth}
              className="cth-conv-resize"
              style={{
                position: 'absolute', top: 0, bottom: 0, left: -3, width: 7, zIndex: 6,
                cursor: 'col-resize', touchAction: 'none'
              }}
            />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexShrink: 0,
              boxShadow: 'inset 0 -1px 0 var(--cth-ink-300)', fontSize: 12, fontWeight: 600,
              color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)'
            }}>
              <span style={{ flex: 1 }}>{t('conversation.questions')}</span>
              <button type="button" onClick={() => setQuestionsOpen(false)} aria-label={t('conversation.questionsClose')}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--cth-ink-500)', fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <AskMeTab />
            </div>
          </aside>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: showConversation ? 'none' : 'flex' }}>
        {raw}
      </div>
      {!showConversation && composer}
    </>
  );
}
