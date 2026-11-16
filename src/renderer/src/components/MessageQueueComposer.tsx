import { ClipboardEvent, DragEvent, KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { clearTerminalDraft, dismissTerminalPicker, terminalAutomationBlockFor } from './terminalPool';
import type { TerminalAutomationBlock } from './terminalAutomation';
import { useTerminalFontSize } from './terminalFontSize';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';
import { supportsConversation, useTerminalViewMode } from './ConversationView';
import { ChatPlusMenu } from './ChatPlusMenu';
import { parseInboxNudge } from '@shared/hiveNudge';
import { InboxNudgeSummary } from './InboxMail';
import { markQueuedDismissed, useDeliveryPaused } from './ConversationExtras';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** A file/image attached to the draft. Travels to the agent as a PATH it Reads. */
interface Attachment {
  path: string;
  name: string;
}

// Prepended (only to the enqueued value, never the visible draft) when the

export interface MessageQueueComposerProps {
  agent: Agent;
}

/**
 * Lets the user keep messaging an agent whose terminal is mid-run. Typed
 * messages park in a per-agent queue and are submitted to the agent's Claude
 * TUI one-by-one as soon as it goes idle (see useHive's flush loop).
 */
export function MessageQueueComposer({ agent }: MessageQueueComposerProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  // In the Conversation view the composer is part of the chat: same surface,
  // a rounded input with attach (+) on the left and a send arrow on the right.
  const viewMode = useTerminalViewMode();
  const chat = supportsConversation(agent) && viewMode === 'conversation';
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const enqueueMessage = useStore((s) => s.enqueueMessage);
  const removeQueuedMessage = useStore((s) => s.removeQueuedMessage);
  const releaseQueuedMessage = useStore((s) => s.releaseQueuedMessage);
  const clearQueue = useStore((s) => s.clearQueue);

  // Draft lives in the store, keyed by agent — switching agents remounts this
  // component, and component-local state would silently eat the typed text.
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const setText = (t: string) => setDraft(agent.id, t);

  // The draft box is the terminal's twin — it should read at the same size the
  // agent's output does, at every zoom level.
  const composerFontSize = useTerminalFontSize();
  const composerLineHeight = Math.round(composerFontSize * 1.4);

  const idle = agent.status === 'idle';

  // Only the god/Michael agent gets the delegation toggle. Default OFF.

  // Files/images staged for the next message. Component-local: switching agents
  // remounts this component, so attachments are cleared on tab switch (drafts
  // persist in the store, attachments deliberately don't carry over).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addAttachments = (incoming: Attachment[]) =>
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const fresh = incoming.filter((a) => a.path && !seen.has(a.path));
      return fresh.length ? [...prev, ...fresh] : prev;
    });

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // '+' button → OS picker (images group + all files).
  const pickFiles = async () => {
    const res = await window.cth.attachFiles();
    if (res.ok) addAttachments(res.files);
  };

  // Drop files onto the composer → resolve each to its absolute path.
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (!dropped.length) return;
    const atts = dropped
      .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
      .filter((a) => a.path);
    if (atts.length) addAttachments(atts);
  };

  // Paste a screenshot (no path → persist the native clipboard image to a temp
  // file) or paste files copied from the OS file manager (carry a real path).
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const hasImage = items.some((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) addAttachments([res.file]);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      const atts = files
        .map((f) => ({ path: window.cth.pathForFile(f), name: f.name }))
        .filter((a) => a.path);
      if (atts.length) {
        e.preventDefault();
        addAttachments(atts);
      }
    }
  };

  const canSend = !!text.trim() || attachments.length > 0;

  const queueIt = () => {
    if (!canSend) return;
    // Prepend an "Attached files:" block using the same path-based convention as
    // the Slack inbound path (useHive.ts) so agents Read the files directly.
    const body = attachments.length
      ? (text.trim()
          ? `${text}\n\nAttached files:\n`
          : 'Attached files:\n') + attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')
      : text;
    enqueueMessage(agent.id, body);
    // Counted HERE, at the composer's submit, and NOT inside enqueueMessage:
    // that store action is also how work orders, Slack inbound, nudges and
    // compact commands reach an agent, and none of those is a person sending a
    // message. Past the isComposingKey guard in onKey, so an IME candidate
    // Enter never counts. (TELEMETRY.md → message_sent)
    void window.cth.trackMessageSent('composer');
    setText('');
    setAttachments([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      queueIt();
    }
  };

  // Delivery can be held back by the agent's own terminal (a half-typed draft or
  // an open slash-command picker owns the prompt). That used to be invisible —
  // the hint claimed it was sending while nothing moved — so poll it and say so.
  // Poll whenever something is queued, busy or not: a busy agent is exactly when
  // a user might have half-typed in the terminal above, and it is when the queue
  // is in use — so the hold must be reported then, not only once the agent idles.
  const block = useTerminalBlock(agent.ptyId, queue.length > 0);

  // Floor-wide auto-delivery pause (Command Center switch) also holds the queue.
  // Without saying so — and without the per-row "send now" override — messages
  // look permanently stuck with no explanation and no escape hatch.
  const deliveryPaused = useDeliveryPaused(agent.id, queue.length > 0);

  const statusHint = queue.length === 0
    ? null
    : block === 'draft'
    ? t('queueComposer.heldDraft', { name: agent.name })
    : block === 'picker'
    ? t('queueComposer.heldPicker', { name: agent.name })
    : block === 'exited'
    ? t('queueComposer.heldExited', { name: agent.name })
    : !idle
    ? t('queueComposer.busyQueued', { name: agent.name, count: queue.length })
    : deliveryPaused && !queue[0]?.manual
    ? t('queueComposer.heldFloor')
    : t('queueComposer.sendingOneByOne', { name: agent.name });

  const attachmentChips = attachments.length > 0 && (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {attachments.map((a) => (
        <span
          key={a.path}
          title={a.path}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            maxWidth: '100%',
            padding: '2px 4px 2px 6px',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            borderRadius: chat ? 6 : undefined,
            fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)'
          }}
        >
          <Icon name="folder" />
          <span style={{
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 180
          }}>{a.name}</span>
          <button
            onClick={() => removeAttachment(a.path)}
            title={t('queueComposer.removeAttachment')}
            style={{
              flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--cth-ink-500)', padding: 0,
              display: 'inline-flex', alignItems: 'center'
            }}
          >
            <Icon name="x" />
          </button>
        </span>
      ))}
    </div>
  );

  const holdAction = (block === 'draft' || block === 'picker') && agent.ptyId && (
    <button
      onClick={() => {
        if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
        const discarded = clearTerminalDraft(agent.ptyId!);
        if (discarded.trim()) setText(text ? `${text}\n${discarded}` : discarded);
      }}
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
        fontFamily: 'var(--cth-font-ui)', fontSize: 12,
        color: 'var(--cth-ink-900)', textDecoration: 'underline'
      }}
    >{block === 'picker' ? t('queueComposer.closePicker') : t('queueComposer.recoverPrompt')}</button>
  );

  if (chat) {
    const chatFont = composerFontSize + 1;
    const chatLine = Math.round(chatFont * 1.45);
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        onDrop={onDrop}
        style={{
          flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
          padding: '8px 12px 12px', background: 'var(--cth-paper-100)',
          fontFamily: 'var(--cth-font-ui)'
        }}
      >
        {queue.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-500)', minWidth: 0 }}>
            <span title={statusHint ?? undefined} style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {statusHint}
            </span>
            {holdAction}
            {queue.length > 1 && (
              <button
                onClick={() => { markQueuedDismissed(queue.map((m) => m.id)); clearQueue(agent.id); }}
                title={t('queueComposer.clearAllTitle')}
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)'
                }}
              >{t('queueComposer.clearAll')}</button>
            )}
          </div>
        )}
        {/* Queued messages show in the thread itself (ConversationView). */}
        <div
          className="cth-chat-input"
          style={{
            display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 8px 6px 10px',
            borderRadius: 14, background: 'var(--cth-cream-50)',
            boxShadow: dragOver ? 'inset 0 0 0 2px var(--cth-lilac)' : undefined
          }}
        >
          {dragOver && (
            <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', textAlign: 'center' }}>
              {t('queueComposer.dropToAttach')}
            </span>
          )}
          {attachmentChips}
          <textarea
            ref={chatInputRef}
            dir={rtl ? 'auto' : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            rows={2}
            placeholder={idle ? t('queueComposer.messagePlaceholder', { name: agent.name }) : t('queueComposer.busyPlaceholder', { name: agent.name })}
            style={{
              width: '100%', resize: 'none', border: 'none', outline: 'none', padding: 0,
              background: 'transparent', boxSizing: 'border-box',
              minHeight: chatLine * 2, maxHeight: chatLine * 12, fieldSizing: 'content',
              fontFamily: 'var(--cth-font-ui)', fontSize: chatFont, lineHeight: `${chatLine}px`,
              color: 'var(--cth-ink-900)'
            } as React.CSSProperties}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ChatPlusMenu
              selfId={agent.id}
              onFiles={() => void pickFiles()}
              onInsert={(snippet) => {
                const el = chatInputRef.current;
                // A slash command only works at the start of the message.
                if (snippet.startsWith('/')) {
                  setText(`${snippet}${text.replace(/^\s+/, '')}`);
                  requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(snippet.length, snippet.length); });
                  return;
                }
                const at = el ? el.selectionStart : text.length;
                const end = el ? el.selectionEnd : text.length;
                const before = text.slice(0, at);
                const pad = before && !/\s$/.test(before) ? ' ' : '';
                const next = `${before}${pad}${snippet}${text.slice(end)}`;
                setText(next);
                const caret = before.length + pad.length + snippet.length;
                requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
              }}
            />
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={queueIt}
              disabled={!canSend}
              title={t('commandBar.send')}
              aria-label={t('commandBar.send')}
              style={{
                width: 30, height: 30, borderRadius: 8, border: 'none',
                cursor: canSend ? 'pointer' : 'default',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: canSend ? 'var(--cth-coral)' : 'var(--cth-cream-200)',
                color: canSend ? 'var(--cth-on-accent)' : 'var(--cth-ink-300)',
                transform: 'rotate(-90deg)', transition: 'background 120ms'
              }}
            >
              <Icon name="arrow-right" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the composer, not on child enter.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--cth-ink-100)',
        background: 'var(--cth-cream-100)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        boxShadow: dragOver ? 'inset 0 0 0 2px var(--cth-lilac)' : undefined
      }}>
      {dragOver && (
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '16px',
          color: 'var(--cth-ink-700)', textAlign: 'center'
        }}>{t('queueComposer.dropToAttach')}</span>
      )}
      {/* Header: label, count, status, clear-all */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 11, lineHeight: '16px',
          color: 'var(--cth-ink-700)'
        }}>{t('queueComposer.queue')}</span>
        {queue.length > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
          }}>{queue.length}</span>
        )}
        {statusHint && (
          <span
            title={deliveryPaused && !queue[0]?.manual
              ? t('queueComposer.pausedTitle')
              : statusHint}
            style={{
              fontSize: 12,
              color: idle ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}
          >{statusHint}</span>
        )}
        {(block === 'draft' || block === 'picker') && agent.ptyId && (
          <button
            onClick={() => {
              // A picker and a draft are unblocked by different keys: Escape
              // closes the picker, Ctrl-U kills the input line. Sending Ctrl-U
              // at a picker leaves it open while telling automation the prompt
              // is free, which is how a queued message ends up typed into a
              // menu and marked delivered.
              if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
              // Keep whatever was on the prompt — it lands in this composer so
              // the user can send it properly instead of losing it to Ctrl-U.
              const discarded = clearTerminalDraft(agent.ptyId!);
              if (discarded.trim()) setText(text ? `${text}\n${discarded}` : discarded);
            }}
            title={block === 'picker'
              ? "Close the picker this agent has open so queued messages can be delivered"
              : "Move the leftover text on this agent's prompt into this box so queued messages can be delivered"}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-900)', textDecoration: 'underline'
            }}
          >{block === 'picker' ? t('queueComposer.closePicker') : t('queueComposer.recoverPrompt')}</button>
        )}
        {queue.length > 1 && (
          <button
            onClick={() => { markQueuedDismissed(queue.map((m) => m.id)); clearQueue(agent.id); }}
            title={t('queueComposer.clearAllTitle')}
            style={{
              marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
              color: 'var(--cth-ink-500)'
            }}
          >{t('queueComposer.clearAll')}</button>
        )}
      </div>

      {/* Pending list */}
      {queue.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          maxHeight: 280, overflowY: 'auto'
        }}>
          {queue.map((m, i) => (
            <QueuedMessageRow
              key={m.id}
              index={i}
              message={m}
              agentId={agent.id}
              paused={deliveryPaused}
              onSendNow={() => releaseQueuedMessage(agent.id, m.id)}
              onRemove={() => { markQueuedDismissed([m.id]); removeQueuedMessage(agent.id, m.id); }}
            />
          ))}
        </div>
      )}

      {/* Attached files/images — chips with a remove 'x', above the textarea. */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {attachments.map((a) => (
            <span
              key={a.path}
              title={a.path}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                maxWidth: '100%',
                padding: '2px 4px 2px 6px',
                background: 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="folder" />
              <span style={{
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 180
              }}>{a.name}</span>
              <button
                onClick={() => removeAttachment(a.path)}
                title={t('queueComposer.removeAttachment')}
                style={{
                  flexShrink: 0, border: 'none', background: 'transparent', cursor: 'pointer',
                  color: 'var(--cth-ink-500)', padding: 0,
                  display: 'inline-flex', alignItems: 'center'
                }}
              >
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Composer — full-width input above a single tidy control bar (cc-ui-polish),
          with file/image attachment chips + paste-to-attach (rich-composer). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          dir={rtl ? 'auto' : undefined}
          className="cth-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={5}
          placeholder={idle ? t('queueComposer.messagePlaceholder', { name: agent.name }) : t('queueComposer.busyPlaceholder', { name: agent.name })}
          style={{
            width: '100%',
            resize: 'vertical',
            // Track the terminal's zoom (Cmd +/- or the terminal's own zoom
            // buttons) instead of a hardcoded 13px. On a large display the
            // terminal text scaled up while this box stayed tiny; box height is
            // derived from the same size so the visible line count is stable.
            minHeight: composerLineHeight * 5 + 14,
            maxHeight: composerLineHeight * 18,
            padding: '6px 8px',
            background: 'var(--cth-paper-100)',
            border: 'none',
            // Border lives in .cth-input so :focus can change it — an inline
            // boxShadow here would outrank the stylesheet and the focus state
            // would silently never apply.
            fontFamily: 'var(--cth-font-mono)',
            fontSize: composerFontSize, lineHeight: `${composerLineHeight}px`,
            color: 'var(--cth-ink-900)',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {/* Control bar: Attach + Send aligned right. flexWrap so a
            narrow sidebar wraps the buttons onto a second row instead of
            pushing Send off-screen. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ flex: 1 }} />
          <PixelButton variant="secondary" size="sm" onClick={pickFiles}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" /> {t('queueComposer.files')}
            </span>
          </PixelButton>
          <PixelButton variant="primary" size="sm" onClick={queueIt} disabled={!canSend}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {t('commandBar.send')} <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

/** Poll the pty's automation block while there is something waiting on it. The
 * flag lives in the terminal pool (a plain module map, not the store), so there
 * is nothing to subscribe to — a 1s tick while the queue is pending is enough. */
function useTerminalBlock(ptyId: string | undefined, active: boolean): TerminalAutomationBlock {
  const [block, setBlock] = useState<TerminalAutomationBlock>(null);
  useEffect(() => {
    if (!ptyId || !active) { setBlock(null); return; }
    const read = () => setBlock(terminalAutomationBlockFor(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId, active]);
  // 'settling' is a sub-second gap between writes — not worth telling anyone.
  return block === 'settling' ? null : block;
}

/**
 * One pending queue row. Collapsed it clamps to 2 lines; "see more" expands it
 * in place so a long message can be read without hovering for the tooltip. The
 * toggle only renders when the text actually clips, so short messages stay tidy.
 */
function QueuedMessageRow(
  { index, message, agentId, paused, onSendNow, onRemove }: {
    index: number;
    message: QueuedMessage;
    agentId: string;
    /** Floor-wide auto-delivery is paused — offer the per-message override. */
    paused: boolean;
    onSendNow: () => void;
    onRemove: () => void;
  }
) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nudgeIds = parseInboxNudge(message.text);

  // Measure against the CLAMPED box, so the toggle survives being expanded (the
  // expanded box never overflows and would otherwise report clipped = false).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (expanded) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // The panel is resizable — re-measure on width changes, not just text ones.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [message.text, expanded]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6,
      padding: '4px 6px',
      background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <span style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 12,
        color: 'var(--cth-ink-500)', lineHeight: '18px', flexShrink: 0
      }}>{`${index + 1}.`}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          ref={bodyRef}
          dir={rtl ? 'auto' : undefined}
          title={expanded || nudgeIds ? undefined : message.text}
          style={{
            fontSize: 12, lineHeight: '18px',
            color: 'var(--cth-ink-900)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            ...(expanded
              // Cap the expanded body so one long message can't push the rest of
              // the queue out of the list's own 280px scroll area.
              ? { maxHeight: 220, overflowY: 'auto' as const }
              : {
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                })
          }}
        >{nudgeIds ? <InboxNudgeSummary agentId={agentId} ids={nudgeIds} /> : message.text}</div>
        {(clipped || expanded || paused) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {(clipped || expanded) && (
              <button
                onClick={() => setExpanded((e) => !e)}
                title={expanded ? t('queueComposer.collapse') : t('queueComposer.showFull')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-500)', textDecoration: 'underline'
                }}
              >{expanded ? t('queueComposer.seeLess') : t('queueComposer.seeMore')}</button>
            )}
            {paused && !message.manual && (
              <button
                onClick={onSendNow}
                title={t('queueComposer.sendNowTitle')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
                  color: 'var(--cth-ink-900)', textDecoration: 'underline'
                }}
              >{t('queueComposer.sendNow')}</button>
            )}
            {paused && message.manual && (
              <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                {t('queueComposer.sendingWhenFree')}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onRemove}
        title={t('queueComposer.removeFromQueue')}
        style={{
          flexShrink: 0, border: 'none', background: 'transparent',
          cursor: 'pointer',
          color: 'var(--cth-ink-500)', padding: 0,
          display: 'inline-flex', alignItems: 'center'
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
