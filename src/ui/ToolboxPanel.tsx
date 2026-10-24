import { Braces, Wrench } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { snippetInsertion, type ToolboxSnippet } from '../toolbox';
import { Button } from './Button';
import { ToolboxVisual } from './ToolboxVisuals';

interface ToolboxPanelProps {
  snippets: ToolboxSnippet[];
  /** The code being edited, so snippets can adapt to it (for example, picking an unused PID name). */
  source: string;
  /** The text of the line the editor cursor is on. */
  getCursorLine?: () => string;
  onInsert: (code: string, setup?: string[]) => void;
}

const POPOVER_WIDTH = 720;

export function ToolboxPanel({ snippets, source, getCursorLine, onInsert }: ToolboxPanelProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();
  const [selectedId, setSelectedId] = useState(snippets[0]?.id ?? '');
  const selected = useMemo(
    () => snippets.find((snippet) => snippet.id === selectedId) ?? snippets[0],
    [selectedId, snippets],
  );

  // The button sits mid-header, so line the popover up with it but keep it on screen.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = buttonRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const margin = 8;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
      setPopoverStyle({ left, top: anchor.bottom + 4, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  if (!selected) return null;

  return (
    <div ref={buttonRef}>
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
        <div
          style={popoverStyle}
          className="fixed z-30 max-h-[calc(100vh-4rem)] overflow-y-auto rounded-md border border-input bg-popover p-2 text-popover-foreground shadow-xl shadow-black/50"
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)]">
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
                    onClick={() => {
                      const insertion = snippetInsertion(selected, source, getCursorLine?.() ?? '');
                      onInsert(insertion.usage, insertion.setup);
                      setOpen(false);
                    }}
                  >
                    <Braces />
                    Insert usage
                  </Button>
                </div>
              </div>

              <div className="mt-3">
                <ToolboxVisual snippetId={selected.id} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
