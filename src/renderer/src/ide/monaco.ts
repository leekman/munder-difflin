/**
 * Monaco bootstrap for the Electron renderer (electron-vite / Vite).
 *
 * Two things have to be true for Monaco to work in a bundled Electron app:
 *
 *  1. Workers must be SELF-HOSTED, not fetched from a CDN. We import each
 *     language worker through Vite's `?worker` suffix, which emits a real
 *     bundled worker chunk and a constructor. `MonacoEnvironment.getWorker`
 *     hands Monaco the right one per language. This is the electron-vite-safe
 *     equivalent of the classic `getWorkerUrl` CDN dance — it works offline and
 *     inside the packaged `app.asar` because the worker URL is resolved by Vite
 *     at build time (relative `base: './'`).
 *
 *  2. `@monaco-editor/react` must use THIS bundled `monaco` instance rather than
 *     its default behaviour of lazy-loading monaco from a CDN via AMD. We pin it
 *     with `loader.config({ monaco })`.
 *
 * Import this module once (for its side effects) before any editor mounts.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  }
};

let themesDefined = false;

/** Register the CTH light/dark Monaco themes (idempotent). */
function defineThemes(m: typeof monaco): void {
  if (themesDefined) return;
  themesDefined = true;
  // Fork perso: Orca's neutral palettes (Monaco needs literal hex — it cannot
  // read the --cth-* CSS variables). Keep in step with design/tokens.css.
  m.editor.defineTheme('cth-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '0a0a0a', background: 'ffffff' },
      { token: 'comment', foreground: '737373', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7c4dff' },
      { token: 'string', foreground: '008a5e' },
      { token: 'number', foreground: 'd6334a' },
      { token: 'type', foreground: '0089ba' },
      { token: 'function', foreground: 'c25a00' },
      { token: 'variable', foreground: '0a0a0a' },
      { token: 'delimiter', foreground: '737373' }
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#0a0a0a',
      'editorLineNumber.foreground': '#a1a1a1',
      'editorLineNumber.activeForeground': '#525252',
      'editor.selectionBackground': '#d4d4d4',
      'editor.lineHighlightBackground': '#f5f5f5',
      'editorCursor.foreground': '#0a0a0a',
      'editorGutter.background': '#ffffff',
      'editorWidget.background': '#fafafa',
      'editorIndentGuide.background1': '#e5e5e5',
      'diffEditor.insertedTextBackground': '#00c75833',
      'diffEditor.removedTextBackground': '#fb2c3633',
      'diffEditor.insertedLineBackground': '#00c75822',
      'diffEditor.removedLineBackground': '#fb2c3622'
    }
  });
  m.editor.defineTheme('cth-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'fafafa', background: '0a0a0a' },
      { token: 'comment', foreground: '8a8a8a', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'a685ff' },
      { token: 'string', foreground: '00d294' },
      { token: 'number', foreground: 'ff667f' },
      { token: 'type', foreground: '00bcfe' },
      { token: 'function', foreground: 'ff8b1a' },
      { token: 'variable', foreground: 'fafafa' },
      { token: 'delimiter', foreground: 'a1a1a1' }
    ],
    colors: {
      'editor.background': '#0a0a0a',
      'editor.foreground': '#fafafa',
      'editorLineNumber.foreground': '#525252',
      'editorLineNumber.activeForeground': '#a1a1a1',
      'editor.selectionBackground': '#404040',
      'editor.lineHighlightBackground': '#171717',
      'editorCursor.foreground': '#fafafa',
      'editorGutter.background': '#0a0a0a',
      'editorWidget.background': '#171717',
      'editorIndentGuide.background1': '#262626',
      'diffEditor.insertedTextBackground': '#00c75833',
      'diffEditor.removedTextBackground': '#fb2c3633',
      'diffEditor.insertedLineBackground': '#00c75822',
      'diffEditor.removedLineBackground': '#fb2c3622'
    }
  });
}

let configured = false;

/** Pin @monaco-editor/react to the bundled monaco + register themes. Idempotent. */
export function setupMonaco(): typeof monaco {
  if (!configured) {
    configured = true;
    loader.config({ monaco });
  }
  defineThemes(monaco);
  return monaco;
}

export const CTH_MONACO_THEME = 'cth-light';
/** Monaco theme id matching the app theme (dark by default in this fork). */
export function cthMonacoTheme(app: 'dark' | 'light'): string {
  return app === 'dark' ? 'cth-dark' : 'cth-light';
}

/** Map a filename to a Monaco language id (used to set the model language). */
export function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'md':
    case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'c':
    case 'h': return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'sh':
    case 'bash':
    case 'zsh': return 'shell';
    case 'html':
    case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'yml':
    case 'yaml': return 'yaml';
    case 'toml': return 'ini';
    case 'xml': return 'xml';
    case 'sql': return 'sql';
    case 'lua': return 'lua';
    case 'ps1': return 'powershell';
    case 'bat':
    case 'cmd': return 'bat';
    case 'dockerfile': return 'dockerfile';
    default:
      if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
      return 'plaintext';
  }
}
