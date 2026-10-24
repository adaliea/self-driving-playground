import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ExternalLink, Maximize2, Plus, Search, X } from 'lucide-react';
import { PopoutWindow, openPopoutWindow } from './PopoutWindow';
import { LineSwatch, TelemetryChart, type ChartSeries } from './TelemetryChart';
import { assignSlots, colorblindPalette, setColorblindCharts, slotStyle, useColorblindCharts } from './chartStyles';
import { graphSignalKey, type TelemetryHistory } from './telemetryHistory';
import type { NamedPidTelemetry } from './pidTelemetry';
import { defaultSignals, telemetrySamples, telemetrySignals } from './telemetrySignals';

const POPOUT_WINDOW_NAME = 'self-driving-playground-telemetry';
const iconButton = 'rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const quietButton = 'rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

interface GraphTab { id: number; name: string; selected: string[] }

/** Swatch for signals that are not on the graph; they get a real style once selected. */
const unselectedStyle = { color: colorblindPalette.grey, colorblindColor: colorblindPalette.grey, pattern: 'solid' } as const;

export function TelemetryExplorer({ history, controllers, running }: {
  history: TelemetryHistory; controllers: NamedPidTelemetry[]; running: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [popout, setPopout] = useState<Window>();
  const [tabs, setTabs] = useState<GraphTab[]>([{ id: 1, name: 'Graph 1', selected: [...defaultSignals] }]);
  const nextId = useRef(2);
  const [activeId, setActiveId] = useState(1);
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState<TelemetryHistory>();
  const colorblind = useColorblindCharts();
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
  const signals = telemetrySignals(controllers, data.graphs);
  // A graph(...) series appears on every tab the first time it is recorded; deselecting it afterwards sticks.
  const announcedGraphs = useRef(new Set<string>());
  useEffect(() => {
    const fresh = Object.keys(history.graphs ?? {}).map(graphSignalKey).filter((key) => !announcedGraphs.current.has(key));
    if (!fresh.length) return;
    for (const key of fresh) announcedGraphs.current.add(key);
    setTabs((previous) => previous.map((tab) => ({ ...tab, selected: [...tab.selected, ...fresh.filter((key) => !tab.selected.includes(key))] })));
  }, [history.graphs]);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  // Styles come from the selection, so a graph's lines never share a colour and dash.
  const slotsByTab = useRef(new Map<number, Record<string, number>>());
  // Every selected key keeps its slot, even while its signal is briefly unavailable, such as a graph() series after a reset.
  const slots = assignSlots(active.selected, slotsByTab.current.get(active.id));
  slotsByTab.current.set(active.id, slots);
  const styled = (signal: (typeof signals)[number]): ChartSeries => ({ ...signal, ...(slots[signal.key] === undefined ? unselectedStyle : slotStyle(slots[signal.key])) });
  const selected = signals.filter((signal) => slots[signal.key] !== undefined).map(styled);
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
    slotsByTab.current.delete(id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  };
  const closePopout = useCallback(() => setPopout(undefined), []);
  const popOut = () => {
    if (popout && !popout.closed) {
      popout.focus();
      return;
    }
    const target = openPopoutWindow(POPOUT_WINDOW_NAME);
    if (!target) {
      // Popup blocked: keep the workspace available in this window instead.
      setOpen(true);
      return;
    }
    setOpen(false);
    setPopout(target);
  };
  const inWindow = Boolean(popout);
  const workspace = (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border pl-4 pr-2 sm:pl-6">
          <h2 id={headingId} className="text-sm font-medium">Telemetry</h2>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${frozen ? 'bg-warning' : running ? 'bg-signal' : 'bg-muted-foreground'}`} />
              {frozen ? 'History held' : running ? 'Live' : 'Simulation paused'}
            </span>
            <button type="button" aria-pressed={colorblind} onClick={() => setColorblindCharts(!colorblind)} className={`${quietButton} ml-2 flex items-center gap-1.5`}>
              <span aria-hidden="true" className={`flex h-3 w-3 items-center justify-center rounded-sm border ${colorblind ? 'border-signal bg-signal text-signal-foreground' : 'border-muted-foreground'}`}>{colorblind ? <Check size={9} strokeWidth={3} /> : null}</span>
              Colorblind-friendly
            </button>
            <button type="button" onClick={() => setFrozen((value) => value ? undefined : history)} className={quietButton}>{frozen ? 'Resume live' : 'Hold history'}</button>
            {inWindow ? (
              <button type="button" aria-label="Close telemetry window" onClick={closePopout} className={iconButton}><X size={16} /></button>
            ) : <>
              <button type="button" aria-label="Open telemetry in a new window" title="Open in new window" onClick={popOut} className={iconButton}><ExternalLink size={15} /></button>
              <button type="button" autoFocus aria-label="Close telemetry" onClick={() => setOpen(false)} className={iconButton}><X size={16} /></button>
            </>}
          </div>
        </header>
        <nav aria-label="Graph tabs" className="flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-border">
          {tabs.map((tab) => <div key={tab.id} className={`relative flex shrink-0 items-center border-r border-border ${active.id === tab.id ? 'bg-card text-foreground after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-signal' : 'text-muted-foreground hover:text-foreground'}`}>
            <button type="button" aria-pressed={active.id === tab.id} onClick={() => setActiveId(tab.id)} className="h-full max-w-48 truncate px-4 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">{tab.name || `Graph ${tab.id}`}</button>
            {tabs.length > 1 ? <button type="button" aria-label={`Remove ${tab.name || `Graph ${tab.id}`}`} onClick={() => removeTab(tab.id)} className="-ml-2 mr-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><X size={12} /></button> : null}
          </div>)}
          <button type="button" onClick={addTab} className="flex shrink-0 items-center gap-1 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"><Plus size={13} aria-hidden="true" /> Add graph</button>
        </nav>
        <main className="min-h-0 flex-1 overflow-auto lg:flex lg:overflow-hidden">
          <section aria-label="Signal selection" className="shrink-0 border-b border-border p-4 lg:w-72 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <details open className="group">
              <summary className="cursor-pointer text-sm font-medium">Signals <span className="ml-1 font-mono text-xs font-normal tabular-nums text-muted-foreground">{selected.length}/{signals.length}</span></summary>
              <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-input px-2.5 focus-within:ring-1 focus-within:ring-ring"><Search size={13} className="text-muted-foreground" aria-hidden="true" />
                <input aria-label="Find a signal" placeholder="Find a signal…" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 bg-transparent text-xs outline-none" />
              </label>
              <div className="my-2 flex gap-1 text-xs">
                <button type="button" onClick={() => updateTab({ selected: signals.map((signal) => signal.key) })} className={quietButton}>Select all</button>
                <button type="button" onClick={() => updateTab({ selected: [] })} className={quietButton}>Clear</button>
              </div>
              <div className="max-h-56 space-y-4 overflow-y-auto lg:max-h-none">
                {groups.map((group) => <fieldset key={group}>
                  <legend className="mb-1 px-2 text-xs text-muted-foreground">{group}</legend>
                  <div>{visible.filter((signal) => signal.group === group).map((signal) => <label key={signal.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
                    <input type="checkbox" checked={active.selected.includes(signal.key)} onChange={() => toggle(signal.key)} className="accent-signal" />
                    <LineSwatch series={styled(signal)} colorblind={colorblind} />
                    <span>{signal.label}</span>
                  </label>)}</div>
                </fieldset>)}
                {!visible.length ? <p className="text-xs text-muted-foreground">No matching signals.</p> : null}
              </div>
            </details>
          </section>
          <section aria-label="Selected graph" className="flex min-w-0 flex-1 flex-col p-4 lg:min-h-0 lg:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <input aria-label="Graph name" maxLength={60} value={active.name} placeholder={`Graph ${active.id}`} onChange={(event) => updateTab({ name: event.target.value })} className="-ml-2 min-w-0 max-w-full rounded border border-transparent bg-transparent px-2 py-1 text-base font-medium hover:border-border focus:border-ring focus:outline-none" />
            </div>
            <div className="flex min-h-[22rem] flex-1 flex-col rounded-md border border-border p-2 sm:p-4">
              {selected.length ? <TelemetryChart key={`${data.version}:${active.id}`} name={active.name} history={telemetrySamples(data)} series={selected} height="fill"
                note="Scroll to zoom · Drag to pan · Hold history to inspect a fixed time range" /> : <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">Select signals to build this graph. Speed, outputs, and PID terms can be combined here.</div>}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">30 seconds of simulation time. Signals use separate scales by unit; hover for values. Lead signals track the nearest vehicle ahead in your lane. Positive relative forward velocity means the gap is opening.</p>
          </section>
        </main>
      </div>
  );
  return <>
    <div className="flex items-center">
      <button type="button" onClick={() => popout ? popout.focus() : setOpen(true)} className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Maximize2 size={13} aria-hidden="true" /> {popout ? 'Show telemetry window' : 'Explore telemetry'}
      </button>
      {popout ? null : (
        <button type="button" aria-label="Open telemetry in a new window" title="Open in new window" onClick={popOut} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      )}
    </div>
    {open && !popout ? createPortal(<dialog ref={dialog} aria-labelledby={headingId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none bg-background p-0 text-foreground backdrop:bg-black/80">
      {workspace}
    </dialog>, document.body) : null}
    {popout ? <PopoutWindow target={popout} title="Telemetry – PID Autopilot Playground" onClose={closePopout}>
      <div className="h-full bg-background text-foreground">{workspace}</div>
    </PopoutWindow> : null}
  </>;
}
