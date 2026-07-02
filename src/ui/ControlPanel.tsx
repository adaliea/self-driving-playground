import { Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { PlaygroundSettings } from '../types';
import { Toggle } from './Toggle';

interface ControlPanelProps {
  running: boolean;
  settings: PlaygroundSettings;
  onRunningChange: (running: boolean) => void;
  onReset: () => void;
  onSettingsChange: (settings: PlaygroundSettings) => void;
}

export function ControlPanel({ running, settings, onRunningChange, onReset, onSettingsChange }: ControlPanelProps) {
  const [open, setOpen] = useState(false);
  const update = <K extends keyof PlaygroundSettings>(key: K, value: PlaygroundSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <section className="relative z-20 border-b border-white/10 bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onRunningChange(!running)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-mint px-3 text-sm font-semibold text-ink shadow-glow transition hover:bg-[#8bfade]"
        >
          {running ? <Pause size={16} /> : <Play size={16} />}
          {running ? 'Pause' : 'Start'}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-white/12 bg-white/[0.045] px-3 text-sm font-medium text-slate-100 transition hover:border-mint/40"
        >
          <RotateCcw size={16} />
          Reset
        </button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-white/12 bg-white/[0.045] px-3 text-sm font-medium text-slate-100 transition hover:border-mint/40"
          aria-expanded={open}
        >
          <SlidersHorizontal size={16} />
          Settings
        </button>
      </div>

      {open ? (
        <div className="absolute right-4 top-[calc(100%-0.25rem)] w-[min(28rem,calc(100vw-2rem))] rounded-md border border-white/12 bg-panel p-3 shadow-2xl shadow-black/50">
          <div className="grid gap-2">
            <label className="flex h-9 items-center gap-2 rounded-md border border-white/10 bg-black/20 px-3 text-xs uppercase tracking-[0.18em] text-slate-400">
              Seed
              <input
                value={settings.seed}
                onChange={(event) => update('seed', Number.parseInt(event.target.value, 10) || 0)}
                className="w-20 bg-transparent text-sm font-semibold tracking-normal text-slate-100 outline-none"
                type="number"
              />
            </label>

            <RangeControl
              label="Traffic"
              value={settings.trafficDensity}
              min={0}
              max={1}
              step={0.05}
              display={`${estimatedTrafficCount(settings.trafficDensity)} cars`}
              onChange={(value) => update('trafficDensity', value)}
            />
            <RangeControl
              label="Start speed"
              value={settings.startingSpeed}
              min={8}
              max={34}
              step={1}
              display={`${Math.round(settings.startingSpeed)} m/s`}
              onChange={(value) => update('startingSpeed', value)}
            />

            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle
                label="Noisy lane lines"
                checked={settings.noisyLaneLines}
                onChange={(checked) => update('noisyLaneLines', checked)}
              />
              <Toggle
                label="Noisy boxes"
                checked={settings.noisyVehicles}
                onChange={(checked) => update('noisyVehicles', checked)}
              />
              <Toggle
                label="Actuator variation"
                checked={settings.actuatorVariation}
                onChange={(checked) => update('actuatorVariation', checked)}
              />
              <Toggle
                label="Debug overlays"
                checked={settings.debugOverlays}
                onChange={(checked) => update('debugOverlays', checked)}
              />
            </div>

            <Toggle
              label="Steer for me"
              detail="Lane-centering overrides steering"
              checked={settings.steerAssist}
              onChange={(checked) => update('steerAssist', checked)}
            />
            <Toggle
              label="Accelerate for me"
              detail="Adaptive cruise overrides motor"
              checked={settings.accelerateAssist}
              onChange={(checked) => update('accelerateAssist', checked)}
            />

            <div className="text-xs text-slate-500">Seed and starting speed apply on reset. Density changes live.</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}

function RangeControl({ label, value, min, max, step, display, onChange }: RangeControlProps) {
  return (
    <label className="flex h-9 items-center gap-3 rounded-md border border-white/10 bg-black/20 px-3">
      <span className="w-20 text-xs uppercase tracking-[0.18em] text-slate-400">{label}</span>
      <input
        className="h-1 min-w-20 flex-1 accent-mint"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-16 text-right text-xs font-semibold text-slate-100">{display}</span>
    </label>
  );
}

function estimatedTrafficCount(density: number): number {
  return Math.round(10 + Math.max(0, Math.min(1, density)) ** 1.28 * 122);
}
