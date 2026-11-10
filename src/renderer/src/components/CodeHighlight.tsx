/**
 * Syntax colouring for the Conversation view's tool details: code (Monaco's
 * own colorizer, same themes as the IDE), diffs (+/- lines), terminal output
 * (ANSI colours) and `git diff`-style output.
 *
 * Monaco is loaded lazily, the first time a block needs it, and the plain text
 * shows until then. Its colorizer escapes the source text itself; we only
 * inject the markup it returns.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useAppTheme } from '@/design/theme';

export type CodeKind = 'code' | 'diff' | 'output';

type Monaco = typeof import('monaco-editor');
let monacoPromise: Promise<{ monaco: Monaco; languageForPath: (p: string) => string; theme: (t: 'dark' | 'light') => string }> | null = null;
function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = import('@/ide/monaco').then((m) => ({
      monaco: m.setupMonaco(), languageForPath: m.languageForPath, theme: m.cthMonacoTheme
    }));
  }
  return monacoPromise;
}

/** Colourised HTML lines for `text` in `language`, or null while loading. */
function useColorized(text: string, language: string | undefined, path: string | undefined): string[] | null {
  const appTheme = useAppTheme();
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    setLines(null);
    if (!language && !path) return;
    // Very large blocks stay plain: colouring them would stall the UI.
    if (text.length > 120_000) return;
    loadMonaco().then(async ({ monaco, languageForPath, theme }) => {
      const lang = language ?? languageForPath(path!);
      if (!lang || lang === 'plaintext') return;
      monaco.editor.setTheme(theme(appTheme === 'dark' ? 'dark' : 'light'));
      const html = await monaco.editor.colorize(text, lang, { tabSize: 2 });
      if (alive) setLines(html.replace(/<br\/>$/, '').split('<br/>'));
    }).catch(() => { /* stay plain */ });
    return () => { alive = false; };
  }, [text, language, path, appTheme]);
  return lines;
}

const lineStyle: CSSProperties = { display: 'block', minHeight: '1.45em', paddingInline: 8 };
const plainStyle: CSSProperties = { display: 'block', paddingInline: 8 };

/** Plain or colourised rows for `body` (no diff markers). */
function CodeLines({ body, language, path, decorate }: {
  body: string; language?: string; path?: string;
  decorate?: (i: number, row: ReactNode) => ReactNode;
}) {
  const html = useColorized(body, language, path);
  const raw = body.split('\n');
  return (
    <>
      {raw.map((l, i) => {
        const row = html && html[i] !== undefined
          ? <span dangerouslySetInnerHTML={{ __html: html[i] || '&nbsp;' }} />
          : <span>{l || ' '}</span>;
        return decorate ? decorate(i, row) : <span key={i} style={lineStyle}>{row}</span>;
      })}
    </>
  );
}

const DIFF_BG: Record<string, string> = {
  '+': 'color-mix(in srgb, var(--cth-mint) 22%, transparent)',
  '-': 'color-mix(in srgb, var(--cth-coral) 20%, transparent)'
};

/** Unified-ish diff: each line starts with '+', '-' or ' ' (or is a header). */
function DiffLines({ text, path }: { text: string; path?: string }) {
  const raw = text.split('\n');
  const marks = raw.map((l) => {
    if (/^(\+\+\+|---)\s/.test(l) || /^(diff --git|index |@@)/.test(l)) return 'h';
    return l[0] === '+' || l[0] === '-' ? l[0] : ' ';
  });
  const body = raw.map((l, i) => (marks[i] === 'h' ? l : l.slice(marks[i] === ' ' && l[0] !== ' ' ? 0 : 1))).join('\n');
  return (
    <CodeLines
      body={body}
      path={path}
      decorate={(i, row) => {
        const m = marks[i];
        return (
          <span key={i} style={{
            ...lineStyle, background: DIFF_BG[m],
            color: m === 'h' ? 'var(--cth-ink-500)' : undefined,
            fontWeight: m === 'h' ? 600 : undefined
          }}>
            {m !== 'h' && (
              <span style={{ userSelect: 'none', display: 'inline-block', width: '1.2em', color: m === '+' ? 'var(--cth-mint)' : m === '-' ? 'var(--cth-coral)' : 'var(--cth-ink-300)' }}>
                {m === ' ' ? '' : m}
              </span>
            )}
            {row}
          </span>
        );
      }}
    />
  );
}

// ─── ANSI (SGR colours) ──────────────────────────────────────────────────────

const ANSI_COLORS = ['#3b3b3b', '#d14d41', '#3a9a5b', '#b98a18', '#3f7fd6', '#a052c4', '#2a9aa6', '#b0b0b0'];
const ANSI_BRIGHT = ['#7a7a7a', '#ef6b5e', '#4fc27a', '#e0b23c', '#6aa5f2', '#c27ae3', '#47c2ce', '#e6e6e6'];
// eslint-disable-next-line no-control-regex
const SGR_SPLIT = /\x1b\[([0-9;]*)m/;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07]*\x07/g;

function AnsiText({ text }: { text: string }) {
  const parts = text.replace(OTHER_ESC, '').split(SGR_SPLIT);
  const out: ReactNode[] = [];
  let style: CSSProperties = {};
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out.push(<span key={i} style={style}>{parts[i]}</span>);
      continue;
    }
    const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number);
    const next: CSSProperties = { ...style };
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) { for (const key of Object.keys(next)) delete (next as Record<string, unknown>)[key]; }
      else if (c === 1) next.fontWeight = 700;
      else if (c === 2) next.opacity = 0.7;
      else if (c === 3) next.fontStyle = 'italic';
      else if (c === 4) next.textDecoration = 'underline';
      else if (c === 22) { delete next.fontWeight; delete next.opacity; }
      else if (c >= 30 && c <= 37) next.color = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) next.color = ANSI_BRIGHT[c - 90];
      else if (c === 39) delete next.color;
      else if (c >= 40 && c <= 47) next.background = ANSI_COLORS[c - 40];
      else if (c === 49) delete next.background;
      else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
        const rgb = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
        if (c === 38) next.color = rgb; else next.background = rgb;
        k += 4;
      } else if ((c === 38 || c === 48) && codes[k + 1] === 5) {
        const n = codes[k + 2];
        const col = n < 8 ? ANSI_COLORS[n] : n < 16 ? ANSI_BRIGHT[n - 8] : undefined;
        if (col) { if (c === 38) next.color = col; else next.background = col; }
        k += 2;
      }
    }
    style = next;
  }
  return <>{out}</>;
}

/** Claude Code's Read output: "   12→code" (or "12\tcode") per line. */
const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/;

/** The coloured body of one block. */
export function HighlightedText({ text, kind, path, language }: {
  text: string; kind: CodeKind; path?: string; language?: string;
}) {
  if (kind === 'diff' || (kind === 'output' && looksLikeDiff(text))) {
    return <DiffLines text={text} path={kind === 'diff' ? path : undefined} />;
  }
  if (kind === 'output') {
    // eslint-disable-next-line no-control-regex
    if (/\x1b\[/.test(text)) return <span style={plainStyle}><AnsiText text={text} /></span>;
    // Read results: keep the line numbers as a gutter and colour the code.
    const lines = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').split('\n');
    const numbered = path && lines.length > 1 && lines.filter((l) => l.trim()).every((l) => NUMBERED.test(l));
    if (numbered) {
      const nums: string[] = [];
      const code: string[] = [];
      for (const l of lines) {
        const m = l.match(NUMBERED);
        if (!m) continue;
        nums.push(m[1]);
        code.push(m[2]);
      }
      return (
        <CodeLines
          body={code.join('\n')}
          path={path}
          decorate={(i, row) => (
            <span key={i} style={lineStyle}>
              <span style={{ userSelect: 'none', display: 'inline-block', minWidth: '3ch', marginRight: 10, textAlign: 'right', color: 'var(--cth-ink-300)' }}>{nums[i]}</span>
              {row}
            </span>
          )}
        />
      );
    }
    return <span style={plainStyle}>{text}</span>;
  }
  return <CodeLines body={text} path={path} language={language} />;
}

function looksLikeDiff(text: string): boolean {
  return /^(diff --git |@@ -\d)/m.test(text) && /^[+-]/m.test(text);
}
