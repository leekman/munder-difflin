import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, selectedAgent, floorRepo } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DEFAULT_ORG_TRIGGER } from '@shared/triggers';
import { useHive } from '@/hooks/useHive';
import { useGodNameSync } from '@/i18n/useGodNameSync';
import { useDirectionSync } from '@/i18n/useDirection';
import { useArabicTerminalSync } from '@/terminal/useArabicTerminalSync';
import { MEMORY_OVERLAY_HOST_ID } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { AddAgentModal } from '@/components/AddAgentModal';
import { ComposeTeamModal } from '@/components/ComposeTeamModal';
import { shouldHighlightCompose } from '@/components/composeTeamFlow';
import { MichaelBooting } from '@/components/MichaelBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { HivePicker } from '@/components/HivePicker';
import { FloorRepoPicker } from '@/components/FloorRepoPicker';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { UpdateToast } from '@/components/UpdateToast';
import { UpdateBadge } from '@/components/UpdateBadge';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { SettingsModal, type Section as SettingsSection } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal, notifyThemeChangeAll } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { IdePanel } from '@/ide/IdePanel';
import brandLogo from '@brand/logo.png?url';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

const LS_AGENT_COLUMN_WIDTH = 'cth.agentColumnWidth';
const AGENT_COLUMN_DEFAULT = 260;
const AGENT_COLUMN_MIN = 200;
const AGENT_COLUMN_MAX = 420;
/** Collapsed agent column: a rail of avatars (fork perso). */
const LS_AGENT_COLUMN_COLLAPSED = 'cth.agentColumnCollapsed';
const AGENT_COLUMN_COLLAPSED_WIDTH = 54;

function readAgentColumnCollapsed(): boolean {
  try { return window.localStorage.getItem(LS_AGENT_COLUMN_COLLAPSED) === '1'; } catch { return false; }
}

function clampAgentColumnWidth(px: number): number {
  return Math.min(AGENT_COLUMN_MAX, Math.max(AGENT_COLUMN_MIN, Math.round(px)));
}

/** Last path segment, for the title-bar repo label. */
function repoName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function readAgentColumnWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(LS_AGENT_COLUMN_WIDTH));
    return raw > 0 ? clampAgentColumnWidth(raw) : AGENT_COLUMN_DEFAULT;
  } catch {
    return AGENT_COLUMN_DEFAULT;
  }
}

export function App() {
  // Point every {{godName}} string at the orchestrator's real, renameable name.
  useGodNameSync();
  // Mirror the document only for a user who has picked an RTL app language.
  useDirectionSync();
  // Let terminals that are ALREADY open follow a language switch too.
  useArabicTerminalSync();
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const composeTeamOpen = useStore(s => s.composeTeamOpen);
  const setComposeTeamOpen = useStore(s => s.setComposeTeamOpen);
  const { t } = useTranslation();
  const highlightCompose = shouldHighlightCompose(agents);
  const clearPendingHires = useStore(s => s.clearPendingHires);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const appThemeNow = useAppTheme();
  // Agent column width (left). New key on purpose: the old `cth.sidebarWidth`
  // measured the terminal panel on the RIGHT and must not be reinterpreted.
  const [agentColumnWidth, setAgentColumnWidthState] = useState<number>(readAgentColumnWidth);
  const setAgentColumnWidth = useCallback((px: number) => {
    const next = clampAgentColumnWidth(px);
    setAgentColumnWidthState(next);
    try { window.localStorage.setItem(LS_AGENT_COLUMN_WIDTH, String(next)); } catch { /* storage unavailable */ }
  }, []);
  const [agentColumnCollapsed, setAgentColumnCollapsed] = useState<boolean>(readAgentColumnCollapsed);
  // The width transition runs only around a toggle — during a splitter drag
  // it would make the column lag behind the cursor.
  const [agentColumnAnimating, setAgentColumnAnimating] = useState(false);
  const toggleAgentColumn = useCallback(() => {
    setAgentColumnAnimating(true);
    setTimeout(() => setAgentColumnAnimating(false), 220);
    setAgentColumnCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(LS_AGENT_COLUMN_COLLAPSED, next ? '1' : '0'); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  const ideOpen = useStore(s => s.ideOpen);
  const setIdeOpen = useStore(s => s.setIdeOpen);

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  // The harness switcher (header button). There is no launch-time harness
  // picker any more: a floor's repo decides its harness (main/repoHarness.ts).
  const [harnessPickerOpen, setHarnessPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which tab Settings opens on. Set by a `cth:open-settings` deep link, reset
   *  to undefined (→ General) whenever the modal is opened the normal way. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // Deep link into Settings from anywhere in the tree. Settings' open state is
  // local to App, so a nested control (e.g. "set it now" beside a disabled Talk
  // button) has no path to it without threading a prop through every layer
  // between; a window event keeps that plumbing out of the components in
  // between, matching the existing `cth:` CustomEvent convention.
  useEffect(() => {
    const onOpenSettings = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('cth:open-settings', onOpenSettings);
    return () => window.removeEventListener('cth:open-settings', onOpenSettings);
  }, []);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the triggers so Settings → Connections and the Command Center's
      // Triggers tab read one list, not two copies that drift — whichever surface
      // saves calls these same setters and the other repaints. No extra IPC: main
      // deep-fills both fields on every config read (withTriggerDefaults), so
      // getConfig() already serves what listWebhooks()/getOrgTrigger() would.
      // `c` is typed as the PRELOAD's HarnessConfig, which hasn't picked the two
      // fields up yet (another lane's file); the renderer mirror type declares them.
      const withTriggers = c as HarnessConfig;
      useStore.getState().setWebhookTriggers(withTriggers.webhookTriggers ?? []);
      useStore.getState().setOrgTrigger(withTriggers.orgTrigger ?? DEFAULT_ORG_TRIGGER);
    });
    return () => { cancelled = true; };
  }, []);

  // Config subscription — the copy loaded above would otherwise go stale the
  // moment anything saves a setting.
  useEffect(() => window.cth.onConfigChanged(setConfig), []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // Shareable hires: a validated manifest arriving via the munderdifflin://
  // deep link (or file import) pre-fills the Add-Agent modal. Never spawns by itself.
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const closeAddAgentReview = () => {
    clearPendingHires();
    setAddAgentOpen(false);
  };
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      enqueuePendingHires([m]);
      setAddAgentOpen(true);
    });
    // Pull anything that arrived before this subscription existed (cold-start
    // deep links; packaged renderers load too fast for push-on-load).
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        enqueuePendingHires(queued);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [enqueuePendingHires, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking. Held
  // off until the user opens a hive in the launch picker (passing null no-ops the
  // hook) so Michael doesn't boot against the current home while the user may be
  // about to switch to a different one.
  // An unbound window (no floor repo yet) boots nothing: it only shows the
  // repo picker, and god belongs to a floor.
  useHive(floorRepo !== null ? config : null);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty floor, and stop it the instant the first real PTY agent appears
  // (Michael always spawns, so in normal operation it effectively never runs).
  useEffect(() => {
    if (!config?.onboardingComplete || floorRepo === null) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Re-apply the persisted focus-mode preference as the roster fills in.
  //
  // Not a one-shot at store construction: at launch every restored agent still
  // carries the PREVIOUS session's PTY id, so the reconcile above prunes the lot
  // and correctly drops focus mode to null before god has respawned. The
  // preference therefore has to be re-checked once agents with live terminals
  // actually exist. `restoreFocusMode` is a no-op unless the preference is on and
  // focus mode is currently off, so re-running it on every roster change is safe
  // and pressing Esc stays sticky.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    useStore.getState().restoreFocusMode();
  }, [config?.onboardingComplete, agents]);

  // Track viewport width for splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    return <OnboardingWizard onComplete={(next) => { setConfig(next); }} />;
  }

  // One window = one repo, and the repo picks its harness: a window not bound
  // to a repo yet shows only the repo picker — no floor, no god boot. Choosing
  // a repo reloads the window (or switches the app to the repo's harness).
  if (floorRepo === null) {
    return <FloorRepoPicker />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* v0.3.4: background-update toast ("restart to update"); renders null until
          main's updater pushes a status. */}
      <UpdateToast />
      {/* Title bar */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 36, minHeight: 36,
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          gap: 12,
          userSelect: 'none'
        }}
      >
        <img
          src={brandLogo}
          alt="Munder Difflin"
          style={{ height: 20, width: 'auto', display: 'block' }}
        />
        {/* v0.3.7: the version is no longer inert text — it doubles as the
            update control (check / download / restart to update). */}
        <UpdateBadge />
        <span
          className="cth-titlebar-nodrag"
          title={floorRepo}
          style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--cth-ink-900)',
            maxWidth: 240,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}
        >
          {repoName(floorRepo)}
        </span>
        <button
          className="cth-titlebar-nodrag cth-settings-btn"
          onClick={() => setHarnessPickerOpen(true)}
          title={config.harnessHome ?? ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 24, padding: '0 8px', maxWidth: 200,
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
          }}
        >
          <Icon name="folder" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('floor.harnessLabel', { name: repoName(config.harnessHome ?? '') })}
          </span>
        </button>
        {/* Primary (filled) while the floor has no worker yet — god doesn't count. */}
        <button
          className={highlightCompose ? 'cth-titlebar-nodrag' : 'cth-titlebar-nodrag cth-settings-btn'}
          onClick={() => setComposeTeamOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 24, padding: '0 8px',
            background: highlightCompose ? 'var(--cth-ink-900)' : 'var(--cth-paper-100)',
            boxShadow: `inset 0 0 0 1px ${highlightCompose ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
            border: 'none', borderRadius: 2, cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
            fontWeight: highlightCompose ? 600 : 400,
            color: highlightCompose ? 'var(--cth-cream-50)' : 'var(--cth-ink-900)'
          }}
        >
          <Icon name="sparkle" /> {t('team.button')}
        </button>
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-500)'
        }}>
          {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        {/* v0.3.4: theme + fullscreen live HERE (top right), not buried in the
            terminal header — and the theme darkens the whole app, terminals
            included (design/theme.ts + tokens.css dark block). */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={() => {
            const next = toggleAppTheme();
            // Tell every RUNNING program the theme flipped. xterm repaints its own
            // cells, but a TUI that painted its panels with explicit colours keeps
            // them until it redraws, which left OpenCode's boxes in the old palette
            // until the agent restarted. Only programs that enabled DEC mode 2031
            // are told, and it is every pooled terminal rather than the visible one,
            // so a background agent is not stale when you switch to it.
            notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light');
            // Mirror into the harness config: every agent (re)spawned from now
            // on gets the matching `theme` in its per-session Claude settings,
            // so the TUI's truecolor palette fits the terminal. Scoped to
            // harness agents — the user's global Claude theme is never touched.
            void window.cth.updateConfig({ terminalTheme: next });
          }}
          data-tip={appThemeNow === 'dark' ? 'Light theme' : 'Dark theme'}
          aria-label="Toggle dark mode"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: 1
          }}
        >
          {appThemeNow === 'dark' ? '☀' : '☾'}
        </button>
        {/* v0.3.4: the IDE button moved to agent level — every agent's header
            (sidebar detail, god Command Center, fullscreen) carries it. */}
        <button
          className="cth-titlebar-nodrag cth-settings-btn cth-tip"
          onClick={() => { setSettingsSection(undefined); setSettingsOpen(true); }}
          data-tip="Settings"
          aria-label="Settings"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          <GearGlyph />
        </button>
        {/* Fullscreen. The title bar is chrome, not canvas, so these two use
            clean stroke icons rather than the 16x16 pixel set the rest of the UI
            is drawn in — at 16-18px a pixel-grid glyph reads as a rendering
            artifact next to the OS window controls, not as a style choice. */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={() => {
            if (fullscreenAgentId) { useStore.getState().setFullscreen(null); return; }
            const all = useStore.getState().agents;
            const target = all.find((x) => x.id === useStore.getState().selectedId && x.ptyId)
              ?? all.find((x) => x.isGod && x.ptyId)
              ?? all.find((x) => x.ptyId);
            if (target) useStore.getState().setFullscreen(target.id);
          }}
          data-tip={fullscreenAgentId ? 'Exit focus mode (Esc)' : 'Focus mode'}
          aria-label="Toggle focus mode"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          {fullscreenAgentId ? <CollapseGlyph /> : <ExpandGlyph />}
        </button>

      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        gap: 0
      }}>
        {/* LEFT — the agent column (cards stacked, add/restore pinned at the bottom). */}
        <div style={{
          width: agentColumnCollapsed ? AGENT_COLUMN_COLLAPSED_WIDTH : agentColumnWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column',
          transition: agentColumnAnimating ? 'width 160ms ease-out' : undefined,
          // Collapsed there is no splitter: keep a hairline between rail and terminal.
          borderInlineEnd: agentColumnCollapsed ? '1px solid var(--cth-ink-100)' : 'none'
        }}>
          <AgentStrip config={config} collapsed={agentColumnCollapsed} onToggleCollapsed={toggleAgentColumn} />
        </div>

        {!agentColumnCollapsed && <SidebarSplitter
          width={agentColumnWidth}
          onChange={setAgentColumnWidth}
          viewportWidth={vpWidth}
          min={AGENT_COLUMN_MIN}
          max={AGENT_COLUMN_MAX}
          defaultWidth={AGENT_COLUMN_DEFAULT}
        />}

        {/* RIGHT — the selected agent's terminal, full remaining width, or an empty state.
            Also hosts the OPEN memory panel as an overlay (its pill sits in the column footer). */}
        <div id={MEMORY_OVERLAY_HOST_ID} style={{
          flex: 1, minWidth: 0, minHeight: 0,
          padding: 16,
          position: 'relative',
          display: 'flex', flexDirection: 'column'
        }}>
          {agent ? (
            <>
              {/* God-only floor: the team is still to be composed. */}
              {highlightCompose && (
                <PixelPanel variant="active" style={{
                  marginBottom: 12, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                }}>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
                    {t('team.emptyHint')}
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <PixelButton variant="secondary" size="sm" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                    <PixelButton variant="primary" size="sm" onClick={() => setComposeTeamOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="sparkle" /> {t('team.button')}
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              )}
              <AgentDetailPanel agent={agent} />
            </>
          ) : agentCount === 0 && godStatus === 'booting' ? (
            <MichaelBooting />
          ) : agentCount === 0 ? (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                <PixelPanel variant="dialog" title="Empty floor" noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                      No agents on the floor yet. Spawn one to see real claude output stream in here.
                    </p>
                    <PixelButton variant="primary" size="md" onClick={() => setComposeTeamOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="sparkle" /> {t('team.button')}
                      </span>
                    </PixelButton>
                    <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              </div>
            </div>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>No agent selected</div>
              <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Pick an agent in the column on the left.<br />
                Its terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      {addAgentOpen && (
        <AddAgentModal
          onClose={closeAddAgentReview}
          config={config}
          onConfigChange={setConfig}
        />
      )}

      {composeTeamOpen && (
        <ComposeTeamModal onClose={() => setComposeTeamOpen(false)} />
      )}

      {harnessPickerOpen && (
        <HivePicker config={config} onOpenCurrent={() => setHarnessPickerOpen(false)} onClose={() => setHarnessPickerOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsModal
          config={config}
          initialSection={settingsSection}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
        />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          closing={closing}
          onCancel={() => {
            if (closing) cancelClosingTime();
            window.cth.cancelClose();
            setQuitWarn(null);
          }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
          onClosingTime={startClosingTime}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal config={config} />}
      {ideOpen && <IdePanel />}
      <TaskDetailOverlay />
    </div>
  );
}

/* ── Title-bar glyphs ────────────────────────────────────────────────────────
   Stroke icons on a 16 unit box, inheriting `currentColor` so they follow the
   theme exactly as the pixel set does. Deliberately NOT added to
   components/Icon.tsx: that library is the app's pixel-art identity and is used
   at tab and card scale, where the pixel grid is the point. These three sit
   beside the OS traffic lights, which is the one place that identity reads as a
   blurry asset rather than a decision. */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{children}</svg>
  );
}

/** Four outward corner brackets — enter fullscreen. */
function ExpandGlyph() {
  return (
    <Glyph>
      <path d="M6.2 3H3v3.2M9.8 3H13v3.2M6.2 13H3V9.8M9.8 13H13V9.8" />
    </Glyph>
  );
}

/** The same brackets turned inward — leave fullscreen. */
function CollapseGlyph() {
  return (
    <Glyph>
      <path d="M3 6.2h3.2V3M13 6.2H9.8V3M3 9.8h3.2V13M13 9.8H9.8V13" />
    </Glyph>
  );
}

/** A wrench. The previous glyph was a hub with eight radiating spokes, which at
 *  18px is indistinguishable from a sun — sitting immediately beside a theme
 *  toggle whose light-mode icon IS a sun. A tool shape carries "settings"
 *  without competing with its neighbour. Drawn on a 24 box for curve headroom
 *  and rendered at 16. */
function GearGlyph() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
    </svg>
  );
}
