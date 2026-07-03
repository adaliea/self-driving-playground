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
        variant="outline"
        size="sm"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Wrench className="text-blue-300" />
        Toolbox
      </Button>

      {open ? (
        <div className="absolute right-0 top-10 z-30 w-[min(34rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg lg:w-[min(34rem,calc(50vw-2rem))]">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="grid content-start gap-2">
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => setSelectedId(snippet.id)}
                  className={`min-w-0 rounded-md border px-3 py-2 text-left text-xs transition ${
                    selected.id === snippet.id
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-100'
                      : 'border-border bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <span className="block truncate font-semibold">{snippet.title}</span>
                  <span className="mt-1 block text-[10px] uppercase tracking-[0.18em] opacity-70">{snippet.category}</span>
                </button>
              ))}
            </div>

            <div className="min-w-0">
              <div className="rounded-md border border-border bg-card p-3 text-card-foreground">
                <div className="text-sm font-semibold">{selected.title}</div>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">{selected.description}</p>
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

              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-5 text-muted-foreground">
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
      return 'text-blue-300';
    case 'type':
      return 'text-emerald-300';
    case 'string':
      return 'text-green-300';
    case 'number':
      return 'text-yellow-200';
    case 'operator':
      return 'text-muted-foreground';
    default:
      return 'text-foreground';
  }
}
