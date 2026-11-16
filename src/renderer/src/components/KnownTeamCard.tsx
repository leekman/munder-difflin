import { CSSProperties, useState } from 'react';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { resumeTeam } from '@/store/scopeActions';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import type { SavedTeam } from '@/components/scopeFlow';

type TeamAgent = { name?: string; description?: string };

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function meta(team: SavedTeam): string {
  const n = team.agents.length;
  return `${n} agent${n > 1 ? 's' : ''} · composée le ${day(team.createdAt)} · utilisée le ${day(team.usedAt)}`;
}

/** « Équipe déjà connue » : the remembered teams of the floor's scope, most recent first. */
export function KnownTeamCard({ scopeName, config }: { scopeName: string; config: HarnessConfig | null }) {
  const teams = useStore((s) => s.knownTeams);
  const setComposeTeamOpen = useStore((s) => s.setComposeTeamOpen);
  const [showOlder, setShowOlder] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [lead, ...older] = teams;
  if (!lead) return null;

  const resume = async (team: SavedTeam) => {
    if (resuming) return;
    setResuming(true);
    setError('');
    try {
      const notes = await resumeTeam(team, config);
      useStore.getState().setScopeNotice(notes.length ? notes.join(' · ') : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResuming(false);
    }
  };

  const forget = async (team: SavedTeam) => {
    setForgetId(null);
    const st = useStore.getState();
    try {
      await window.cth.teamsForget(team.scope, team.id);
      if (st.currentTeamId === team.id) st.setCurrentTeamId(null);
      st.setKnownTeams(await window.cth.teamsList(team.scope));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PixelPanel variant="active" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ ...textStyle, fontWeight: 600 }}>Équipe déjà connue pour {scopeName}</div>
      <div style={mutedStyle}>{meta(lead)}</div>
      {lead.summary && <p style={{ margin: 0, ...textStyle }}>« {lead.summary} »</p>}
      <ul style={{ margin: 0, paddingInlineStart: 18, ...textStyle }}>
        {(lead.agents as TeamAgent[]).map((a, i) => (
          <li key={i}>{a.name ?? '?'}{a.description ? ` — ${a.description}` : ''}</li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <PixelButton variant="primary" size="sm" disabled={resuming} onClick={() => void resume(lead)}>
          {resuming ? 'Reprise…' : 'Reprendre cette équipe'}
        </PixelButton>
        <PixelButton variant="secondary" size="sm" disabled={resuming} onClick={() => setComposeTeamOpen(true, 'scratch')}>
          Repartir de zéro
        </PixelButton>
      </div>
      {older.length > 0 && (
        <button type="button" onClick={() => setShowOlder((v) => !v)} style={linkStyle}>
          Équipes précédentes ({older.length}) {showOlder ? '▴' : '▾'}
        </button>
      )}
      {showOlder && older.map((team) => (
        <PixelPanel key={team.id} variant="inset" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...mutedStyle, flex: 1 }}>{meta(team)}</span>
            <PixelButton variant="secondary" size="sm" disabled={resuming} onClick={() => void resume(team)}>
              Reprendre
            </PixelButton>
            <button
              type="button"
              title="Oublier cette équipe"
              aria-label="Oublier cette équipe"
              onClick={() => setForgetId(team.id)}
              style={iconBtnStyle}
            >
              <Icon name="x" />
            </button>
          </div>
          {team.summary && <span style={textStyle}>« {team.summary} »</span>}
          {forgetId === team.id && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...textStyle, flex: 1 }}>Oublier cette équipe ? Ses agents ne pourront plus être repris.</span>
              <PixelButton variant="destructive" size="sm" onClick={() => void forget(team)}>Oublier</PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={() => setForgetId(null)}>Annuler</PixelButton>
            </div>
          )}
        </PixelPanel>
      ))}
      {error && <span style={{ fontSize: 12, color: 'var(--cth-danger)' }}>{error}</span>}
    </PixelPanel>
  );
}

const textStyle: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '19px', color: 'var(--cth-ink-900)' };
const mutedStyle: CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)' };
const linkStyle: CSSProperties = {
  alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)', textDecoration: 'underline'
};
const iconBtnStyle: CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
  color: 'var(--cth-ink-500)', display: 'inline-flex'
};
