import { PidGraph } from './PidGraph';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { TelemetryExplorer } from './TelemetryExplorer';
import { recordTelemetry, type TelemetryHistory } from './telemetryHistory';
import type { PidSample } from './pidHistory';
import type { RuntimeInspectionStore } from '../sandbox';
import { pidTelemetryFromInspection } from './pidTelemetry';
import { AlertTriangle, ChevronRight, Info, ShieldCheck } from 'lucide-react';
import type { RenderTelemetry } from '../rendering';
import type { PidDebugTerms } from '../types';

interface TelemetryPanelProps {
  telemetry?: RenderTelemetry;
  inspectionStore: RuntimeInspectionStore;
  compileErrors: string[];
  runtimeError?: string;
}

export function TelemetryPanel({ telemetry, inspectionStore, compileErrors, runtimeError }: TelemetryPanelProps) {
  const inspection = useSyncExternalStore(
    (listener) => inspectionStore.subscribe(listener),
    () => inspectionStore.getState(),
  );
  const automaticControllers = pidTelemetryFromInspection(inspection);
  const controllers = automaticControllers.length ? automaticControllers : [
    ...(telemetry?.debug?.lanePid ? [{ id: 'legacy-lane', name: 'Lane PID', terms: telemetry.debug.lanePid }] : []),
    ...(telemetry?.debug?.speedPid ? [{ id: 'legacy-speed', name: 'Speed PID', terms: telemetry.debug.speedPid }] : []),
  ];
  const [history, setHistory] = useState<TelemetryHistory>({ vehicle: [], pids: {} });
  useEffect(() => {
    if (telemetry) setHistory((previous) => recordTelemetry(previous, inspection.version, telemetry, controllers));
  }, [telemetry, inspection.version, controllers]);
  const speed = telemetry?.speedMph ?? 0;

  return (
    <aside className="relative z-10 max-h-[42vh] min-w-0 overflow-auto border-t border-border bg-background px-4 pb-4">
      <div className="flex h-11 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Telemetry</h2>
        <TelemetryExplorer history={history} controllers={controllers} running={inspection.running} />
      </div>

      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-6">
        <Metric label="Speed" value={speed.toFixed(1)} unit="mph" />
        <Metric label="Lane" value={`${telemetry?.laneIndex ?? 0}`} />
        <Metric label="Motor cmd" value={formatSigned(telemetry?.finalMotor ?? 0)} assisted={telemetry?.motorOverridden} />
        <Metric label="Motor actual" value={formatSigned(telemetry?.actualMotor ?? 0)} />
        <Metric label="Steer cmd" value={formatSigned(telemetry?.finalSteering ?? 0)} assisted={telemetry?.steerOverridden} />
        <Metric label="Steer actual" value={formatSigned(telemetry?.actualSteering ?? 0)} />
      </dl>

      <ul className="mt-3 space-y-1 empty:hidden">
        {telemetry?.steerOverridden ? <StatusLine tone="assist" label="Steering overridden by lane-centering assist" /> : null}
        {telemetry?.motorOverridden ? <StatusLine tone="assist" label="Motor overridden by adaptive cruise assist" /> : null}
        {telemetry?.invalidFields.length ? (
          <StatusLine tone="warning" label={`Invalid output fields clamped: ${telemetry.invalidFields.join(', ')}`} />
        ) : null}
        {telemetry?.collisions ? <StatusLine tone="warning" label={`Ego collision count: ${telemetry.collisions}`} /> : null}
      </ul>

      <div className="grid gap-x-6 xl:grid-cols-2">
        {controllers.map((controller) => (
          <PidBlock key={`${inspection.version}:${controller.id}`} title={controller.name} terms={controller.terms} history={history.pids[controller.id] ?? []} />
        ))}
      </div>

      <div className="mt-4 space-y-2 empty:hidden">
        {compileErrors.length > 0 ? (
          <ErrorBox title="TypeScript compile errors" lines={compileErrors} />
        ) : runtimeError ? (
          <ErrorBox title="Runtime error" lines={[runtimeError]} />
        ) : null}
      </div>
    </aside>
  );
}

function Metric({ label, value, unit, assisted = false }: { label: string; value: string; unit?: string; assisted?: boolean }) {
  return (
    <div className="bg-background px-3 py-2">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {assisted ? <span className="text-signal">assist</span> : null}
      </dt>
      <dd className={`mt-0.5 font-mono text-sm tabular-nums ${assisted ? 'text-signal' : 'text-foreground'}`}>
        {value}
        {unit ? <span className="ml-1 text-xs text-muted-foreground">{unit}</span> : null}
      </dd>
    </div>
  );
}

function StatusLine({ tone, label }: { tone: 'assist' | 'warning'; label: string }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${tone === 'assist' ? 'text-signal' : 'text-warning'}`}>
      {tone === 'assist' ? <ShieldCheck size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
      {label}
    </li>
  );
}

function PidBlock({ title, terms, history }: { title: string; terms?: Partial<PidDebugTerms>; history: PidSample[] }) {
  if (!terms) return null;

  return (
    <section className="mt-5">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="mt-2 grid grid-cols-5 gap-px overflow-visible rounded-md border border-border bg-border font-mono text-xs">
        <PidTerm label="E" value={terms.error} help={pidTermHelp.error} align="left" />
        <PidTerm label="P" value={terms.proportional} help={pidTermHelp.proportional} align="left" />
        <PidTerm label="I" value={terms.integral} help={pidTermHelp.integral} align="center" />
        <PidTerm label="D" value={terms.derivative} help={pidTermHelp.derivative} align="right" />
        <PidTerm label="Out" value={terms.output} help={pidTermHelp.output} align="right" />
      </div>
      <details className="group mt-1">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden="true" />
          History
        </summary>
        <PidGraph name={title} history={history} />
      </details>
    </section>
  );
}

interface PidTermHelp {
  title: string;
  body: string;
  note: string;
}

const pidTermHelp: Record<string, PidTermHelp> = {
  error: {
    title: 'Error',
    body: 'The current difference between the target and measured value.',
    note: 'For lane keeping, this is usually lane-center offset plus a heading term.',
  },
  proportional: {
    title: 'Proportional',
    body: 'Immediate correction based on the current error.',
    note: 'Higher P reacts faster, but too much causes overshoot or weaving.',
  },
  integral: {
    title: 'Integral',
    body: 'Accumulated correction for error that persists over time.',
    note: 'Useful for steady bias. Too much I can wind up and destabilize turns.',
  },
  derivative: {
    title: 'Derivative',
    body: 'Damping based on how quickly the error is changing.',
    note: 'Higher D can reduce oscillation, but noisy sensors make it twitchy.',
  },
  output: {
    title: 'Output',
    body: 'Final PID command after adding P, I, and D and applying limits.',
    note: 'The examples clamp this to the simulator control range.',
  },
};

function PidTerm({
  label,
  value,
  help,
  align,
}: {
  label: string;
  value?: number;
  help: PidTermHelp;
  align: 'left' | 'center' | 'right';
}) {
  const popoverId = useId();
  const alignmentClass =
    align === 'left'
      ? 'left-0'
      : align === 'right'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <div className="group relative bg-background px-2 py-1.5 outline-none first:rounded-l-md last:rounded-r-md focus-within:bg-accent hover:bg-accent">
      <div className="flex items-center gap-1 font-sans text-xs text-muted-foreground">
        <span>{label}</span>
        <button
          type="button"
          aria-describedby={popoverId}
          className="rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Info size={10} />
          <span className="sr-only">Explain {help.title}</span>
        </button>
      </div>
      <div className="mt-0.5 tabular-nums text-foreground">{value !== undefined && Number.isFinite(value) ? formatSigned(value) : '—'}</div>
      <div
        id={popoverId}
        role="tooltip"
        className={`pointer-events-none absolute bottom-[calc(100%+0.5rem)] z-30 hidden w-64 rounded-md border border-input bg-popover p-3 text-left font-sans text-popover-foreground shadow-xl shadow-black/50 group-focus-within:block group-hover:block ${alignmentClass}`}
      >
        <div className="text-sm font-medium text-foreground">{help.title}</div>
        <p className="mt-1 text-xs leading-relaxed">{help.body}</p>
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">{help.note}</p>
      </div>
    </div>
  );
}

function ErrorBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle size={14} aria-hidden="true" />
        {title}
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-destructive-foreground">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

function formatSigned(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0;
  return `${clamped >= 0 ? '+' : ''}${clamped.toFixed(2)}`;
}
