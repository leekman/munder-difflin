/**
 * Readable rendering of the inbox-wake nudge (`📬 inbox: <id>, <id>`).
 *
 * The nudge is typed into the agent's terminal as a plain user turn, so the
 * Conversation view and the message queue used to show the raw message ids.
 * Here each id is looked up in the agent's inbox (pending or already filed
 * under inbox/.done) and shown as "sender chip · subject", the body one click
 * away.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { PixelBadge } from './PixelBadge';
import { AgentMonogram } from './AgentMonogram';

type HiveMessage = Awaited<ReturnType<Window['cth']['hiveInboxMessages']>>[number];

const EMPTY_AGENTS: Agent[] = [];

/** Session cache: a delivered message never changes, so look each id up once. */
const cache = new Map<string, HiveMessage>();
const cacheKey = (agentId: string, id: string) => `${agentId}\u0000${id}`;

/** The messages a nudge names, in nudge order; `loading` until the first answer. */
export function useInboxMessages(agentId: string, ids: string[]): { messages: Map<string, HiveMessage>; loading: boolean } {
  const key = ids.join(',');
  const fromCache = () => {
    const m = new Map<string, HiveMessage>();
    for (const id of ids) {
      const hit = cache.get(cacheKey(agentId, id));
      if (hit) m.set(id, hit);
    }
    return m;
  };
  const [messages, setMessages] = useState(fromCache);
  const [loading, setLoading] = useState(() => messages.size < ids.length);

  useEffect(() => {
    let alive = true;
    const current = fromCache();
    setMessages(current);
    const missing = ids.filter((id) => !current.has(id));
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    let retried = false;
    const load = async () => {
      try {
        const found = await window.cth.hiveInboxMessages(agentId, missing);
        if (!alive) return;
        for (const m of found) cache.set(cacheKey(agentId, m.id), m);
        // A nudge rendered the instant it was typed can beat the file on disk
        // by a moment: look once more before calling an id unknown.
        if (found.length < missing.length && !retried) {
          retried = true;
          setMessages(fromCache());
          setTimeout(() => { if (alive) void load(); }, 3000);
          return;
        }
      } catch { /* main busy — show what we have */ }
      if (!alive) return;
      setMessages(fromCache());
      setLoading(false);
    };
    void load();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, key]);

  return { messages, loading };
}

/** Resolve a hive id (`from`) to a floor agent, live or archived. */
function useFloorAgent(id: string): Agent | undefined {
  const agents = useStore((s) => s.agents) ?? EMPTY_AGENTS;
  const archived = useStore((s) => s.archivedAgents) ?? EMPTY_AGENTS;
  const lower = id.toLowerCase();
  return agents.find((a) => a.id === id || a.name.toLowerCase() === lower)
    ?? archived.find((a) => a.id === id || a.name.toLowerCase() === lower);
}

/**
 * A clickable agent chip (initial, name, live status) that opens that agent's
 * terminal tab. Shared with the Conversation view's agent mentions.
 */
export function AgentChip({ agent, arrow, compact }: { agent: Agent; arrow?: boolean; compact?: boolean }) {
  const select = useStore((s) => s.select);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const setFullscreen = useStore((s) => s.setFullscreen);
  return (
    <button
      type="button"
      title={agent.cwd}
      onClick={(e) => {
        e.stopPropagation();
        if (fullscreenAgentId) setFullscreen(null);
        select(agent.id);
        setSidebarTab('terminal');
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: compact ? '1px 6px 1px 2px' : '3px 8px 3px 4px',
        borderRadius: 999, border: 'none', cursor: 'pointer', maxWidth: '100%', flexShrink: 0,
        background: 'var(--cth-cream-50)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        fontFamily: 'var(--cth-font-ui)', fontSize: '0.85em', color: 'var(--cth-ink-900)',
        opacity: agent.archived ? 0.6 : 1
      }}
    >
      {arrow && <span style={{ color: 'var(--cth-ink-500)', paddingLeft: 4 }}>→</span>}
      <span aria-hidden="true" style={{
        width: 16, height: 16, borderRadius: 4, flexShrink: 0, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700,
        background: `var(--cth-${agent.accent})`, color: 'var(--cth-on-accent)'
      }}>{agent.name.trim().slice(0, 1).toUpperCase()}</span>
      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
      <PixelBadge status={agent.archived ? 'ghost' : agent.status} />
    </button>
  );
}

/** How a non-agent sender reads: the human, the harness, or the raw id. */
function senderLabel(from: string, t: (k: string) => string): string {
  if (from === 'human' || from === 'user') return t('conversation.inboxFromHuman');
  if (from === 'system' || from === 'harness' || !from) return t('conversation.inboxFromSystem');
  return from;
}

/** The sender of a hive message: an agent chip, or a plain label for the human / harness. */
function Sender({ from, compact }: { from: string; compact?: boolean }) {
  const { t } = useTranslation();
  const agent = useFloorAgent(from);
  if (agent) return <AgentChip agent={agent} compact={compact} />;
  return <span style={{ fontWeight: 600, flexShrink: 0, color: 'var(--cth-ink-700)' }}>{senderLabel(from, t)}</span>;
}

/**
 * The incoming-mail mark: the sender's portrait (its sidebar monogram, small)
 * with the send animation's badge turned to ↙ on its corner, in the sender's
 * accent. A sender that is not an agent gets the grey ↙ badge alone.
 */
function ReceiveBadge({ from }: { from?: string }) {
  const agent = useFloorAgent(from ?? '');
  const arrow = (style: React.CSSProperties) => (
    <span aria-hidden="true" style={{
      borderRadius: '50%', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--cth-monogram-bg)', fontWeight: 700, lineHeight: 1, ...style
    }}>↙</span>
  );
  if (!agent) return arrow({ width: 16, height: 16, fontSize: 10.5, background: 'var(--cth-ink-500)' });
  return (
    <span style={{ position: 'relative', flexShrink: 0, width: 22, height: 22, display: 'inline-block', marginRight: 4 }}>
      <AgentMonogram name={agent.name} accent={agent.accent} size={22} />
      {arrow({
        position: 'absolute', right: -5, bottom: -4, width: 12, height: 12, fontSize: 8,
        background: `var(--cth-${agent.accent})`, boxShadow: '0 0 0 1.5px var(--cth-paper-100)'
      })}
    </span>
  );
}

/**
 * The nudge in the Conversation view: one compact bubble per mail, "↙ Message
 * from <sender>" over its subject, sized to its content (not the full width)
 * and tinted with the sender's accent, grey when the sender is not an agent.
 */
export function InboxNudgeCard({ agentId, ids }: { agentId: string; ids: string[] }) {
  const { t } = useTranslation();
  const { messages, loading } = useInboxMessages(agentId, ids);
  return (
    <div style={{
      alignSelf: 'flex-start', maxWidth: '85%', minWidth: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6
    }}>
      {ids.length === 0 && (
        <div style={{ ...rowStyle, ...bubbleStyle(), padding: '6px 10px' }}>
          <ReceiveBadge />
          <span style={{ color: 'var(--cth-ink-700)' }}>{t('conversation.inboxNew')}</span>
        </div>
      )}
      {ids.map((id) => {
        const m = messages.get(id);
        if (!m) {
          // Not on disk any more and never logged: say so plainly, keep the id.
          return (
            <div key={id} title={id} style={{ ...rowStyle, ...bubbleStyle(), padding: '6px 10px', color: 'var(--cth-ink-500)' }}>
              <ReceiveBadge />
              <span>{t('conversation.inboxFromUnknown')}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, ...(idTime(id) ? {} : { fontFamily: 'var(--cth-font-mono)', fontSize: '0.88em' }) }}>
                {loading ? '…' : idTime(id) ?? id}
              </span>
            </div>
          );
        }
        return <MailRow key={id} message={m} />;
      })}
    </div>
  );
}

/** Hive message ids start with their ISO timestamp (`2026-11-10T17-01-30-026Z-…`):
 *  show that as a local time rather than the raw id. */
function idTime(id: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A mail bubble: the sender's accent (tinted fill, accent outline), grey otherwise. */
function bubbleStyle(accent?: string): React.CSSProperties {
  return {
    maxWidth: '100%', minWidth: 0, borderRadius: 10, padding: '4px 10px',
    background: accent ? `var(--cth-${accent}-light)` : 'var(--cth-cream-50)',
    boxShadow: `inset 0 0 0 1px ${accent ? `var(--cth-${accent})` : 'var(--cth-ink-300)'}`
  };
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
  padding: '5px 0', fontSize: '0.95em', color: 'var(--cth-ink-900)'
};

function MailRow({ message }: { message: HiveMessage }) {
  const { t } = useTranslation();
  const sender = useFloorAgent(message.from);
  // Line the subject and body up under the text, past the portrait or the bare badge.
  const indent = sender ? 32 : 22;
  const [open, setOpen] = useState(false);
  const subject = message.subject?.trim() || message.body?.trim().split('\n')[0] || message.id;
  const hasBody = !!message.body?.trim();
  const toggle = () => { if (hasBody) setOpen((o) => !o); };
  return (
    <div style={bubbleStyle(sender?.accent)}>
      <div
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? open : undefined}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
        title={message.id}
        style={{ cursor: hasBody ? 'pointer' : 'default', padding: '5px 0', minWidth: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: '0.95em' }}>
          <ReceiveBadge from={message.from} />
          <span style={{ color: 'var(--cth-ink-500)', flexShrink: 0 }}>{t('conversation.inboxFrom')}</span>
          <Sender from={message.from} />
          <span style={{ flex: 1, minWidth: 8 }} />
          {message.act && (
            <span style={{
              flexShrink: 0, fontSize: '0.8em', color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)'
            }}>{message.act}{message.needs_human ? ' · ⚑' : ''}</span>
          )}
          {hasBody && (
            <span aria-hidden="true" style={{ color: 'var(--cth-ink-500)', width: 10, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
          )}
        </div>
        <div style={{
          paddingLeft: indent, marginTop: 2, fontWeight: 600, color: 'var(--cth-ink-900)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0
        }}>
          {subject}
        </div>
      </div>
      {open && hasBody && (
        <div style={{ padding: `0 0 6px ${indent}px`, fontSize: '0.95em', overflowWrap: 'anywhere', minWidth: 0 }}>
          <MarkdownPreview source={message.body} variant="card" />
        </div>
      )}
    </div>
  );
}

/** The nudge as a compact line in the message queue: "↙ sender · subject". */
export function InboxNudgeSummary({ agentId, ids }: { agentId: string; ids: string[] }) {
  const { t } = useTranslation();
  const { messages } = useInboxMessages(agentId, ids);
  if (!ids.length) return <span>↙ {t('conversation.inboxNew')}</span>;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {ids.map((id) => {
        const m = messages.get(id);
        return (
          <span key={id} title={id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span aria-hidden="true" style={{ color: 'var(--cth-ink-500)' }}>↙</span>
            {m ? (
              <>
                <Sender from={m.from} compact />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {m.subject?.trim() || id}
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('conversation.inboxFromUnknown')}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
