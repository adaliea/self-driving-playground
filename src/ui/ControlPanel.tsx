import { CircleHelp, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { PlaygroundSettings } from '../types';
import { Button } from './Button';
import { NoiseInfoDialog } from './NoiseInfoDialog';
import { Toggle } from './Toggle';

interface ControlPanelProps {
  running: boolean;
  settings: PlaygroundSettings;
  onRunningChange: (running: boolean) => void;
  onReset: () => void;
  onResetSettings: () => void;
  onSettingsChange: (settings: PlaygroundSettings) => void;
}

export function ControlPanel({ running, settings, onRunningChange, onReset, onResetSettings, onSettingsChange }: ControlPanelProps) {
  const [open, setOpen] = useState(false);
  const [noiseInfoOpen, setNoiseInfoOpen] = useState(false);
  const update = <K extends keyof PlaygroundSettings>(key: K, value: PlaygroundSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <section className="relative z-20 border-b border-border bg-background px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => onRunningChange(!running)}>
            {running ? <Pause /> : <Play />}
            {running ? 'Pause' : 'Start'}
          </Button>
          <Button type="button" variant="outline" onClick={onReset}>
            <RotateCcw />
            Reset
          </Button>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          <SlidersHorizontal />
          Settings
        </Button>
      </div>

      {open ? (
        <div className="absolute right-4 top-[calc(100%-0.25rem)] w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="grid gap-2">
            <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Seed
              <input
                value={settings.seed}
                onChange={(event) => update('seed', Number.parseInt(event.target.value, 10) || 0)}
                className="w-20 bg-transparent text-sm font-semibold tracking-normal text-foreground outline-none"
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
              <div className="relative">
                <Toggle
                  label="Noisy vehicle poses"
                  detail="Raw pose noise, dropout & tracked estimates"
                  checked={settings.noisyVehicles}
                  onChange={(checked) => update('noisyVehicles', checked)}
                />
                <button
                  type="button"
                  aria-label="Learn how vehicle measurement noise works"
                  title="How does this noise work?"
                  onClick={() => setNoiseInfoOpen(true)}
                  className="absolute right-12 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300 transition hover:border-emerald-300/40 hover:bg-emerald-400/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-300"
                >
                  <CircleHelp size={14} />
                </button>
              </div>
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

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
              <div className="text-xs text-muted-foreground">Seed and starting speed apply on reset. Density changes live.</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResetSettings}
              >
                <RotateCcw />
                Defaults
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <NoiseInfoDialog open={noiseInfoOpen} onOpenChange={setNoiseInfoOpen} />
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
    <label className="flex h-9 items-center gap-3 rounded-md border border-input bg-background px-3">
      <span className="w-20 text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <input
        className="h-1 min-w-20 flex-1 accent-primary"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-16 text-right text-xs font-semibold text-foreground">{display}</span>
    </label>
  );
}

function estimatedTrafficCount(density: number): number {
  return Math.round(10 + Math.max(0, Math.min(1, density)) ** 1.28 * 122);
}
