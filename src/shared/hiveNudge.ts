/**
 * The inbox-wake nudge — the text queued for an agent that has unread hive mail,
 * and the predicate the message queue uses to keep only one of them pending.
 *
 * The nudge is QUEUED the moment fresh mail is seen but TYPED only once the agent
 * is idle and off cooldown, and it survives a renderer reload in the persisted
 * queue. By the time it lands, the agent has often already drained that mail and
 * filed it under `inbox/.done/` — so the nudge arrives against an inbox the agent
 * itself just emptied.
 */

/** The fixed head of every nudge; the ids that follow differ per nudge. */
const NUDGE_HEAD = '📬 inbox';

/**
 * The head of the long nudge older builds queued. Kept only so a nudge persisted
 * in the message queue by such a build (it survives a renderer reload) is still
 * recognised by the one-pending rule below instead of slipping through as text.
 */
const LEGACY_NUDGE_HEAD = 'You have new hive inbox message(s)';

/**
 * The standing instruction behind the one-line nudge, injected into EVERY agent's
 * prompt. The nudge itself stays a single short line (typed into the PTY with no
 * bracketed paste, so it must never carry a newline); what it means lives here.
 */
export const INBOX_NUDGE_PROTOCOL =
  'When you receive a line starting with "📬 inbox", it means new hive mail: read your inbox, act on everything still pending there, and move handled files to inbox/.done/. Your inbox directory is authoritative; listed ids are hints, and an id already in inbox/.done/ was handled earlier. Act autonomously; only message god if you genuinely need a decision.';

/** God only: how to close an inbox-processing turn for the human watching it. */
export const GOD_INBOX_REPORT =
  'When you process inbox mail, never echo or paste the messages you received. Finish with a short report for the human, in French, 1 to 3 lines: who said what in substance, and what you decided, dispatched or followed up.';

/**
 * Build the nudge, naming the messages that prompted it: `📬 inbox` alone, or
 * `📬 inbox: id1, id2`.
 *
 * The ids are diagnostic, NOT a work list: they let an agent tell "I already
 * handled this last turn" (the id sits in `inbox/.done/`) from "the harness woke
 * me for nothing". The pending inbox stays authoritative — INBOX_NUDGE_PROTOCOL
 * says so in the prompt, since a nudge suppressed by the one-pending rule below
 * leaves its ids unnamed.
 */
export function inboxNudgeText(ids: string[]): string {
  return ids.length ? `${NUDGE_HEAD}: ${ids.join(', ')}` : NUDGE_HEAD;
}

/**
 * Is this queued text an inbox-wake nudge?
 *
 * Matches the fixed head only (current or legacy), since every nudge carries
 * different ids — the point is to recognise the COMMAND, not one instance of it.
 * Mirrors `isCompactionCommand`, and the queue's one-pending rule leans on it the
 * same way.
 */
export function isInboxNudge(text: string): boolean {
  const t = text.trim();
  return t.startsWith(NUDGE_HEAD) || t.startsWith(LEGACY_NUDGE_HEAD);
}

/**
 * Read an inbox-wake nudge back: the message ids it names (`[]` for a bare
 * `📬 inbox` or the legacy long form), or `null` when the text is not a nudge.
 * Lets the UI show who wrote and what about, instead of the raw ids.
 */
export function parseInboxNudge(text: string): string[] | null {
  const t = text.trim();
  if (t.startsWith(LEGACY_NUDGE_HEAD)) return [];
  if (!t.startsWith(NUDGE_HEAD)) return null;
  const rest = t.slice(NUDGE_HEAD.length);
  if (!rest.trim()) return [];
  if (!rest.startsWith(':')) return null;
  return rest.slice(1).split(',').map((x) => x.trim()).filter(Boolean);
}
