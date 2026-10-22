import { Braces, Wrench } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ToolboxSnippet } from '../toolbox';
import { Button } from './Button';

interface ToolboxPanelProps {
  snippets: ToolboxSnippet[];
  onInsert: (snippet: string) => void;
}

export function ToolboxPanel({ snippets, onInsert }: ToolboxPanelProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(snippets[0]?.id ?? '');
  const selected = useMemo(
    () => snippets.find((snippet) => snippet.id === selectedId) ?? snippets[0],
    [selectedId, snippets],
  );

  if (!selected) return null;

  return (
    <div className="relative">
      <Button
        type="button"
        variant={open ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Wrench />
        Toolbox
      </Button>

      {open ? (
        <div className="absolute right-0 top-9 z-30 w-[min(34rem,calc(100vw-2rem))] rounded-md border border-input bg-popover p-2 text-popover-foreground shadow-xl shadow-black/50 lg:w-[min(34rem,calc(50vw-2rem))]">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="grid content-start gap-0.5">
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => setSelectedId(snippet.id)}
                  aria-pressed={selected.id === snippet.id}
                  className={`min-w-0 rounded px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    selected.id === snippet.id
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  }`}
                >
                  <span className="block truncate text-sm">{snippet.title}</span>
                  <span className="block text-xs text-muted-foreground">{snippet.category}</span>
                </button>
              ))}
            </div>

            <div className="min-w-0 p-1">
              <div>
                <div className="text-sm font-medium">{selected.title}</div>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">{selected.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onInsert(selected.usage)}
                  >
                    <Braces />
                    Insert usage
                  </Button>
                </div>
              </div>

              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-muted-foreground">
                <code>{highlightTypeScript(selected.implementation)}</code>
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface CodeToken {
  value: string;
  kind: 'comment' | 'keyword' | 'type' | 'string' | 'number' | 'operator' | 'plain';
}

const keywordSet = new Set([
  'const',
  'let',
  'function',
  'return',
  'if',
  'else',
  'interface',
  'type',
  'extends',
  'undefined',
  'Number',
  'Math',
  'true',
  'false',
]);

const tokenPattern =
  /\/\/.*|(["'`])(?:\\.|(?!\1)[^\\])*\1|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[{}()[\].,:;?+\-*/=<>&|!]+|\s+|./g;

function highlightTypeScript(code: string): ReactNode[] {
  return code.split('\n').flatMap((line, lineIndex, lines) => {
    const nodes: ReactNode[] = tokenizeLine(line).map((token, tokenIndex) => (
      <span key={`${lineIndex}-${tokenIndex}`} className={tokenClassName(token.kind)}>
        {token.value}
      </span>
    ));

    if (lineIndex < lines.length - 1) nodes.push('\n');
    return nodes;
  });
}

function tokenizeLine(line: string): CodeToken[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('/**') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
    return [{ value: line, kind: 'comment' }];
  }

  return [...line.matchAll(tokenPattern)].map((match) => {
    const value = match[0];
    if (value.startsWith('//')) return { value, kind: 'comment' };
    if (/^["'`]/.test(value)) return { value, kind: 'string' };
    if (/^\d/.test(value)) return { value, kind: 'number' };
    if (/^[{}()[\].,:;?+\-*/=<>&|!]+$/.test(value)) return { value, kind: 'operator' };
    if (keywordSet.has(value)) return { value, kind: 'keyword' };
    if (/^[A-Z][A-Za-z0-9_]*$/.test(value)) return { value, kind: 'type' };
    return { value, kind: 'plain' };
  });
}

function tokenClassName(kind: CodeToken['kind']): string {
  switch (kind) {
    case 'comment':
      return 'text-muted-foreground';
    case 'keyword':
      return 'text-[#89a9ff]';
    case 'type':
      return 'text-foreground';
    case 'string':
      return 'text-signal';
    case 'number':
      return 'text-warning';
    case 'operator':
      return 'text-muted-foreground';
    default:
      return 'text-foreground';
  }
}
