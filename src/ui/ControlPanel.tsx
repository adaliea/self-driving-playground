import { CircleHelp, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PlaygroundSettings } from '../types';
import { Button } from './Button';
import { NoiseInfoDialog } from './NoiseInfoDialog';
import { Toggle } from './Toggle';
import { setColorblindCharts, useColorblindCharts } from './chartStyles';

interface ControlPanelProps {
  running: boolean;
  settings: PlaygroundSettings;
  onRunningChange: (running: boolean) => void;
  onReset: () => void;
  onResetSettings: () => void;
  onSettingsChange: (settings: PlaygroundSettings) => void;
  actions?: ReactNode;
}

export function ControlPanel({
  running,
  settings,
  onRunningChange,
  onReset,
  onResetSettings,
  onSettingsChange,
  actions,
}: ControlPanelProps) {
  const [open, setOpen] = useState(false);
  const [noiseInfoOpen, setNoiseInfoOpen] = useState(false);
  const colorblindCharts = useColorblindCharts();
  const update = <K extends keyof PlaygroundSettings>(key: K, value: PlaygroundSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <section className="relative z-20 border-b border-border bg-background px-3">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => onRunningChange(!running)}>
            {running ? <Pause /> : <Play />}
            {running ? 'Pause' : 'Start'}
          </Button>
          <Button type="button" variant="ghost" onClick={onReset}>
            <RotateCcw />
            Reset
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button
            type="button"
            variant={open ? 'secondary' : 'ghost'}
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
          >
            <SlidersHorizontal />
            Settings
          </Button>
        </div>
      </div>

      {open ? (
        <div className="absolute right-3 top-[calc(100%-0.25rem)] w-[min(26rem,calc(100vw-1.5rem))] rounded-md border border-input bg-popover p-3 text-popover-foreground shadow-xl shadow-black/50">
          <div className="grid gap-1">
            <SettingRow label="Seed">
              <input
                value={settings.seed}
                onChange={(event) => update('seed', Number.parseInt(event.target.value, 10) || 0)}
                className="h-7 w-24 rounded border border-input bg-background px-2 text-right font-mono text-xs tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                type="number"
              />
            </SettingRow>

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

            <SectionLabel>Sensors and actuation</SectionLabel>
            <Toggle
              label="Noisy lane lines"
              checked={settings.noisyLaneLines}
              onChange={(checked) => update('noisyLaneLines', checked)}
            />
            <Toggle
              label="Noisy vehicle poses"
              checked={settings.noisyVehicles}
              onChange={(checked) => update('noisyVehicles', checked)}
              accessory={
                <button
                  type="button"
                  aria-label="Learn how vehicle measurement noise works"
                  title="How does this noise work?"
                  onClick={(event) => {
                    event.preventDefault();
                    setNoiseInfoOpen(true);
                  }}
                  className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <CircleHelp size={13} />
                </button>
              }
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

            <SectionLabel>Driver assists</SectionLabel>
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

            <SectionLabel>Charts</SectionLabel>
            <Toggle
              label="Colorblind-friendly charts"
              detail="Safer colours plus dashed and dotted lines"
              checked={colorblindCharts}
              onChange={setColorblindCharts}
            />

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border px-2 pt-3">
              <div className="text-xs text-muted-foreground">Seed and starting speed apply on reset. Density changes live.</div>
              <Button
                type="button"
                variant="ghost"
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
    <SettingRow label={label}>
      <input
        className="h-1 min-w-20 flex-1 accent-signal"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-16 text-right font-mono text-xs tabular-nums text-foreground">{display}</span>
    </SettingRow>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex h-9 items-center gap-3 px-2">
      <span className="w-24 shrink-0 text-sm text-foreground">{label}</span>
      <span className="flex flex-1 items-center justify-end gap-3">{children}</span>
    </label>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mt-3 border-t border-border px-2 pb-1 pt-3 text-xs text-muted-foreground">{children}</div>;
}

function estimatedTrafficCount(density: number): number {
  return Math.round(10 + Math.max(0, Math.min(1, density)) ** 1.28 * 122);
}
