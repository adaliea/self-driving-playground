import { PidGraph } from './PidGraph';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { TelemetryExplorer } from './TelemetryExplorer';
import { recordTelemetry, type TelemetryHistory } from './telemetryHistory';
import type { PidSample } from './pidHistory';
import type { RuntimeInspectionStore } from '../sandbox';
import { pidTelemetryFromInspection } from './pidTelemetry';
import { AlertTriangle, ChevronDown, GitPullRequestArrow, Info, ShieldCheck } from 'lucide-react';
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
    <aside className="relative z-10 max-h-[42vh] min-w-0 overflow-auto border-t border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-foreground">Telemetry</h2>
        <TelemetryExplorer history={history} controllers={controllers} running={inspection.running} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 2xl:grid-cols-3">
        <Metric label="Speed" value={`${speed.toFixed(1)} mph`} />
        <Metric label="Lane" value={`${telemetry?.laneIndex ?? 0}`} />
        <Metric label="Motor cmd" value={formatSigned(telemetry?.finalMotor ?? 0)} accent={telemetry?.motorOverridden} />
        <Metric label="Steer cmd" value={formatSigned(telemetry?.finalSteering ?? 0)} accent={telemetry?.steerOverridden} />
        <Metric label="Motor actual" value={formatSigned(telemetry?.actualMotor ?? 0)} />
        <Metric label="Steer actual" value={formatSigned(telemetry?.actualSteering ?? 0)} />
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {telemetry?.steerOverridden ? <AssistBadge label="Steering overridden by lane-centering assist" /> : null}
        {telemetry?.motorOverridden ? <AssistBadge label="Motor overridden by adaptive cruise assist" /> : null}
        {telemetry?.invalidFields.length ? (
          <WarningBadge label={`Invalid output fields clamped: ${telemetry.invalidFields.join(', ')}`} />
        ) : null}
        {telemetry?.collisions ? <WarningBadge label={`Ego collision count: ${telemetry.collisions}`} /> : null}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {controllers.map((controller) => (
          <PidBlock key={`${inspection.version}:${controller.id}`} title={controller.name} terms={controller.terms} history={history.pids[controller.id] ?? []} />
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {compileErrors.length > 0 ? (
          <ErrorBox title="TypeScript compile errors" lines={compileErrors} />
        ) : runtimeError ? (
          <ErrorBox title="Runtime error" lines={[runtimeError]} />
        ) : null}
      </div>
    </aside>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${accent ? 'border-sky-500/30 bg-sky-500/10' : 'border-border bg-card'}`}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-card-foreground">{value}</div>
    </div>
  );
}

function AssistBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
      <ShieldCheck size={14} />
      {label}
    </div>
  );
}

function WarningBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
      <AlertTriangle size={14} />
      {label}
    </div>
  );
}

function PidBlock({ title, terms, history }: { title: string; terms?: Partial<PidDebugTerms>; history: PidSample[] }) {
  if (!terms) return null;

  return (
    <div className="mt-4 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        <GitPullRequestArrow size={14} />
        {title}
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1 text-center font-mono text-xs">
        <PidTerm label="E" value={terms.error} help={pidTermHelp.error} align="left" />
        <PidTerm label="P" value={terms.proportional} help={pidTermHelp.proportional} align="left" />
        <PidTerm label="I" value={terms.integral} help={pidTermHelp.integral} align="center" />
        <PidTerm label="D" value={terms.derivative} help={pidTermHelp.derivative} align="right" />
        <PidTerm label="Out" value={terms.output} help={pidTermHelp.output} align="right" />
      </div>
      <details className="group mt-3 border-t border-border pt-2">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-sky-400 [&::-webkit-details-marker]:hidden">
          PID history <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
        </summary>
        <PidGraph name={title} history={history} />
      </details>
    </div>
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
    <div className="group relative rounded bg-muted px-1.5 py-2 outline-none focus-within:bg-accent hover:bg-accent">
      <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
        <span>{label}</span>
        <button
          type="button"
          aria-describedby={popoverId}
          className="rounded-full text-muted-foreground outline-none transition hover:text-sky-300 focus-visible:text-sky-300 focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Info size={10} />
          <span className="sr-only">Explain {help.title}</span>
        </button>
      </div>
      <div className="mt-1 text-foreground">{value !== undefined && Number.isFinite(value) ? formatSigned(value) : '—'}</div>
      <div
        id={popoverId}
        role="tooltip"
        className={`pointer-events-none absolute bottom-[calc(100%+0.55rem)] z-30 hidden w-64 rounded-md border border-border bg-popover p-3 text-left font-sans text-popover-foreground shadow-lg group-focus-within:block group-hover:block ${alignmentClass}`}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-foreground">{help.title}</div>
        <p className="mt-2 text-xs leading-relaxed">{help.body}</p>
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">{help.note}</p>
      </div>
    </div>
  );
}

function ErrorBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/20 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-destructive-foreground">
        <AlertTriangle size={14} />
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
