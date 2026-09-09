import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Maximize2, Plus, Search, X } from 'lucide-react';
import { TelemetryChart } from './TelemetryChart';
import type { TelemetryHistory } from './telemetryHistory';
import type { NamedPidTelemetry } from './pidTelemetry';
import { defaultSignals, telemetrySamples, telemetrySignals } from './telemetrySignals';

interface GraphTab { id: number; name: string; selected: string[] }

export function TelemetryExplorer({ history, controllers, running }: {
  history: TelemetryHistory; controllers: NamedPidTelemetry[]; running: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [tabs, setTabs] = useState<GraphTab[]>([{ id: 1, name: 'Graph 1', selected: [...defaultSignals] }]);
  const nextId = useRef(2);
  const [activeId, setActiveId] = useState(1);
  const [query, setQuery] = useState('');
  const [chartHeight, setChartHeight] = useState(480);
  const [frozen, setFrozen] = useState<TelemetryHistory>();
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, [open]);
  useEffect(() => { setFrozen(undefined); }, [history.version]);
  const data = frozen ?? history;
  const signals = telemetrySignals(controllers);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const selected = signals.filter((signal) => active.selected.includes(signal.key));
  const visible = signals.filter((signal) => `${signal.group} ${signal.label}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(visible.map((signal) => signal.group))];
  const updateTab = (update: Partial<GraphTab>) => setTabs((previous) => previous.map((tab) => tab.id === active.id ? { ...tab, ...update } : tab));
  const toggle = (key: string) => updateTab({ selected: active.selected.includes(key) ? active.selected.filter((item) => item !== key) : [...active.selected, key] });
  const addTab = () => {
    const id = nextId.current++;
    setTabs((previous) => [...previous, { id, name: `Graph ${id}`, selected: [...defaultSignals] }]);
    setActiveId(id);
  };
  const removeTab = (id: number) => {
    if (tabs.length === 1) return;
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  };
  return <>
    <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-sky-400">
      <Maximize2 size={14} /> Explore telemetry
    </button>
    {open ? createPortal(<dialog ref={dialog} aria-labelledby={headingId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none bg-background p-0 text-foreground backdrop:bg-black/80">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3"><Activity size={20} className="text-sky-300" /><div>
            <h2 id={headingId} className="text-base font-semibold tracking-wide">Telemetry workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">Choose signals. Compare behavior. Keep a graph for each question.</p>
          </div></div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{frozen ? 'History held' : running ? 'Live' : 'Simulation paused'}</span>
            <button type="button" onClick={() => setFrozen((value) => value ? undefined : history)} className="rounded-md border border-border px-3 py-2 text-xs hover:bg-accent">{frozen ? 'Resume live' : 'Hold history'}</button>
            <button type="button" autoFocus aria-label="Close telemetry" onClick={() => setOpen(false)} className="rounded-md p-2 hover:bg-accent"><X size={20} /></button>
          </div>
        </header>
        <nav aria-label="Graph tabs" className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 py-2 sm:px-6">
          {tabs.map((tab) => <div key={tab.id} className={`flex shrink-0 items-center rounded-md border ${active.id === tab.id ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : 'border-transparent text-muted-foreground'}`}>
            <button type="button" aria-pressed={active.id === tab.id} onClick={() => setActiveId(tab.id)} className="max-w-48 truncate px-3 py-2 text-sm">{tab.name || `Graph ${tab.id}`}</button>
            {tabs.length > 1 ? <button type="button" aria-label={`Remove ${tab.name || `Graph ${tab.id}`}`} onClick={() => removeTab(tab.id)} className="mr-1 rounded p-1 hover:bg-accent"><X size={12} /></button> : null}
          </div>)}
          <button type="button" onClick={addTab} className="flex shrink-0 items-center gap-1 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent"><Plus size={14} /> Add graph</button>
        </nav>
        <main className="min-h-0 flex-1 overflow-auto lg:flex lg:overflow-hidden">
          <section aria-label="Signal selection" className="shrink-0 border-b border-border p-4 lg:w-72 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <details open className="group">
              <summary className="cursor-pointer text-sm font-semibold">Signals <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{selected.length} / {signals.length}</span></summary>
              <label className="mt-4 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"><Search size={14} className="text-muted-foreground" />
                <input aria-label="Find a signal" placeholder="Find a signal…" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 bg-transparent text-xs outline-none" />
              </label>
              <div className="my-3 flex gap-3 text-xs">
                <button type="button" onClick={() => updateTab({ selected: signals.map((signal) => signal.key) })} className="text-sky-300">Select all</button>
                <button type="button" onClick={() => updateTab({ selected: [] })} className="text-muted-foreground">Clear all</button>
              </div>
              <div className="max-h-56 space-y-5 overflow-y-auto lg:max-h-none">
                {groups.map((group) => <fieldset key={group}>
                  <legend className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">{group}</legend>
                  <div className="space-y-1">{visible.filter((signal) => signal.group === group).map((signal) => <label key={signal.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent">
                    <input type="checkbox" checked={active.selected.includes(signal.key)} onChange={() => toggle(signal.key)} className="accent-sky-400" />
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: signal.color }} />
                    <span>{signal.label}</span>
                  </label>)}</div>
                </fieldset>)}
                {!visible.length ? <p className="text-xs text-muted-foreground">No matching signals.</p> : null}
              </div>
            </details>
          </section>
          <section aria-label="Selected graph" className="min-w-0 flex-1 p-4 lg:overflow-y-auto lg:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <input aria-label="Graph name" maxLength={60} value={active.name} placeholder={`Graph ${active.id}`} onChange={(event) => updateTab({ name: event.target.value })} className="min-w-0 max-w-full rounded border border-transparent bg-transparent px-2 py-1 text-lg font-semibold hover:border-border focus:border-sky-400 focus:outline-none" />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">Height
                <input aria-label="Graph height" type="range" min={300} max={900} step={20} value={chartHeight} onChange={(event) => setChartHeight(Number(event.target.value))} className="w-24 accent-sky-400" />
              </label>
            </div>
            <div className="rounded-lg border border-border bg-card p-2 sm:p-4">
              {selected.length ? <TelemetryChart key={`${data.version}:${active.id}`} name={active.name} history={telemetrySamples(data)} series={selected} height={chartHeight}
                note="Scroll to zoom · Drag to pan · Hold history to inspect a fixed time range" /> : <div style={{ height: chartHeight }} className="flex items-center justify-center p-6 text-center text-sm text-muted-foreground">Select signals to build this graph. Speed, outputs, and PID terms can be combined here.</div>}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">30 seconds of simulation time. Signals use separate scales by unit; hover for values. Lead signals track the nearest vehicle ahead in your lane. Positive relative forward velocity means the gap is opening.</p>
          </section>
        </main>
      </div>
    </dialog>, document.body) : null}
  </>;
}
