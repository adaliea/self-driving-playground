import { AlertTriangle, Gauge, GitPullRequestArrow, Info, ShieldCheck } from 'lucide-react';
import type { RenderTelemetry } from '../rendering';

interface TelemetryPanelProps {
  telemetry?: RenderTelemetry;
  compileErrors: string[];
  runtimeError?: string;
}

export function TelemetryPanel({ telemetry, compileErrors, runtimeError }: TelemetryPanelProps) {
  const speed = telemetry?.speedMph ?? 0;
  const lanePid = telemetry?.debug?.lanePid;
  const speedPid = telemetry?.debug?.speedPid;

  return (
    <aside className="relative z-10 max-h-[42vh] min-w-0 overflow-auto border-t border-white/10 bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-mint">Telemetry</h2>
        <Gauge className="text-mint" size={22} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 2xl:grid-cols-3">
        <Metric label="Speed" value={`${speed.toFixed(1)} mph`} />
        <Metric label="Lane" value={`${telemetry?.laneIndex ?? 0} -> ${telemetry?.targetLane ?? 0}`} />
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
        <PidBlock title="Lane PID" terms={lanePid} />
        <PidBlock title="Speed PID" terms={speedPid} />
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
    <div className={`rounded-md border px-3 py-2 ${accent ? 'border-amber/40 bg-amber/10' : 'border-white/8 bg-white/[0.035]'}`}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function AssistBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-mint/25 bg-mint/10 px-3 py-2 text-xs text-mint">
      <ShieldCheck size={14} />
      {label}
    </div>
  );
}

function WarningBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
      <AlertTriangle size={14} />
      {label}
    </div>
  );
}

function PidBlock({ title, terms }: { title: string; terms?: { error: number; proportional: number; integral: number; derivative: number; output: number } }) {
  if (!terms) return null;

  return (
    <div className="mt-4 rounded-md border border-white/8 bg-black/20 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
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
  value: number;
  help: PidTermHelp;
  align: 'left' | 'center' | 'right';
}) {
  const popoverId = `pid-term-${label.toLowerCase()}`;
  const alignmentClass =
    align === 'left'
      ? 'left-0'
      : align === 'right'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <div className="group relative rounded bg-white/[0.045] px-1.5 py-2 outline-none focus-within:bg-white/[0.075] hover:bg-white/[0.075]">
      <div className="flex items-center justify-center gap-1 text-[10px] text-slate-500">
        <span>{label}</span>
        <button
          type="button"
          aria-describedby={popoverId}
          className="rounded-full text-slate-500 outline-none transition hover:text-mint focus-visible:text-mint focus-visible:ring-1 focus-visible:ring-mint/60"
        >
          <Info size={10} />
          <span className="sr-only">Explain {help.title}</span>
        </button>
      </div>
      <div className="mt-1 text-slate-100">{formatSigned(value)}</div>
      <div
        id={popoverId}
        role="tooltip"
        className={`pointer-events-none absolute bottom-[calc(100%+0.55rem)] z-30 hidden w-64 rounded-md border border-mint/25 bg-[#081316] p-3 text-left font-sans shadow-2xl shadow-black/40 group-focus-within:block group-hover:block ${alignmentClass}`}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-mint">{help.title}</div>
        <p className="mt-2 text-xs leading-relaxed text-slate-100">{help.body}</p>
        <p className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-relaxed text-slate-400">{help.note}</p>
      </div>
    </div>
  );
}

function ErrorBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-md border border-red-400/30 bg-red-950/30 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-red-200">
        <AlertTriangle size={14} />
        {title}
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-red-100">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

function formatSigned(value: number): string {
  const clamped = Number.isFinite(value) ? value : 0;
  return `${clamped >= 0 ? '+' : ''}${clamped.toFixed(2)}`;
}
