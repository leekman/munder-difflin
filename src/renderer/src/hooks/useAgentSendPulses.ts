import { useEffect, useRef, useState } from 'react';

/** How long the "just sent a message" cue stays on the sender's row. */
export const SEND_PULSE_MS = 1800;

export interface SendPulse {
  /** Changes on every message, so a second send restarts the CSS animation. */
  key: number;
  /** Resolved recipients (agent ids, or 'human'). */
  targets: string[];
  subject: string;
}

/**
 * Agents that just routed a hive message, keyed by sender id. Fed by the
 * `hive:message` event main emits for every routed message; each entry expires
 * after SEND_PULSE_MS so the cue is a short pulse, not a state.
 */
export function useAgentSendPulses(): Record<string, SendPulse> {
  const [pulses, setPulses] = useState<Record<string, SendPulse>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const seq = useRef(0);

  useEffect(() => {
    const subscribe = window.cth?.onHiveMessage;
    if (typeof subscribe !== 'function') return;
    const off = subscribe((e) => {
      if (!e || typeof e.from !== 'string' || !e.from) return;
      const from = e.from;
      const pulse: SendPulse = {
        key: ++seq.current,
        targets: Array.isArray(e.targets) && e.targets.length > 0 ? e.targets : (e.to ? [e.to] : []),
        subject: typeof e.subject === 'string' ? e.subject : ''
      };
      setPulses((prev) => ({ ...prev, [from]: pulse }));
      clearTimeout(timers.current[from]);
      timers.current[from] = setTimeout(() => {
        delete timers.current[from];
        setPulses((prev) => {
          if (prev[from]?.key !== pulse.key) return prev;
          const next = { ...prev };
          delete next[from];
          return next;
        });
      }, SEND_PULSE_MS);
    });
    const pending = timers.current;
    return () => {
      off?.();
      for (const id of Object.keys(pending)) clearTimeout(pending[id]);
    };
  }, []);

  return pulses;
}
