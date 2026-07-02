import { Braces, ClipboardPlus, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ToolboxSnippet } from '../toolbox';

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
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 text-xs font-semibold text-slate-100 transition hover:border-amber/50"
        aria-expanded={open}
      >
        <Wrench className="text-amber" size={14} />
        Toolbox
      </button>

      {open ? (
        <div className="absolute right-0 top-10 z-30 w-[min(34rem,calc(100vw-2rem))] rounded-md border border-white/12 bg-panel p-3 shadow-2xl shadow-black/55 lg:w-[min(34rem,calc(50vw-2rem))]">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="grid content-start gap-2">
              {snippets.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => setSelectedId(snippet.id)}
                  className={`min-w-0 rounded-md border px-3 py-2 text-left text-xs transition ${
                    selected.id === snippet.id
                      ? 'border-amber/50 bg-amber/10 text-amber'
                      : 'border-white/8 bg-white/[0.035] text-slate-300 hover:border-white/20'
                  }`}
                >
                  <span className="block truncate font-semibold">{snippet.title}</span>
                  <span className="mt-1 block text-[10px] uppercase tracking-[0.18em] opacity-70">{snippet.category}</span>
                </button>
              ))}
            </div>

            <div className="min-w-0">
              <div className="rounded-md border border-white/8 bg-black/20 p-3">
                <div className="text-sm font-semibold text-slate-100">{selected.title}</div>
                <p className="mt-2 text-sm leading-5 text-slate-400">{selected.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onInsert(selected.implementation)}
                    className="inline-flex h-8 items-center gap-2 rounded-md bg-amber px-3 text-xs font-semibold text-ink transition hover:bg-[#ffd98b]"
                  >
                    <ClipboardPlus size={14} />
                    Insert implementation
                  </button>
                  <button
                    type="button"
                    onClick={() => onInsert(selected.usage)}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-white/12 bg-white/[0.045] px-3 text-xs font-semibold text-slate-100 transition hover:border-amber/50"
                  >
                    <Braces size={14} />
                    Insert usage
                  </button>
                </div>
              </div>

              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-white/8 bg-ink p-3 font-mono text-xs leading-5 text-slate-300">
                {selected.implementation}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
