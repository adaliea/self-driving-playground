import { useSyncExternalStore } from 'react';
import type { PidSeries } from './pidHistory';
import type { ChartSeries } from './TelemetryChart';

/**
 * Line pattern used as a secondary cue in colorblind-friendly mode. Colour alone cannot keep
 * more than three overlapping lines distinct for colour-vision deficiencies, so patterns carry it.
 */
export type LinePattern = 'solid' | 'dashed' | 'dotted' | 'dashdot';

export const linePatternDash: Record<LinePattern, number[] | undefined> = {
  solid: undefined,
  dashed: [6, 4],
  dotted: [1.5, 3],
  dashdot: [8, 3, 2, 3],
};

/** Colour and dash for a series in the current chart mode. Patterns only apply in colorblind-friendly mode. */
export function seriesStyle(item: ChartSeries, colorblind: boolean): { color: string; dash?: number[] } {
  if (!colorblind) return { color: item.color };
  return { color: item.colorblindColor ?? item.color, dash: linePatternDash[item.pattern ?? 'solid'] };
}

/**
 * Colorblind-friendly categorical colours, validated against the app background (#070b0d)
 * with the dataviz palette checker: adjacent pairs clear CVD ΔE 8 and normal-vision ΔE 15.
 */
export const colorblindPalette = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  yellow: '#c98500',
  magenta: '#d55181',
  green: '#008300',
  violet: '#9085e9',
  red: '#e66767',
  // Neutrals for result lines, separated from the hues above by lightness and chroma.
  grey: '#8a999c',
  white: '#dde5e6',
} as const;

/** Colorblind-friendly encoding for each PID term, shared with the telemetry explorer. */
export const pidTermColorblindStyle: Record<PidSeries, { colorblindColor: string; pattern: LinePattern }> = {
  error: { colorblindColor: colorblindPalette.yellow, pattern: 'solid' },
  proportional: { colorblindColor: colorblindPalette.blue, pattern: 'solid' },
  integral: { colorblindColor: colorblindPalette.orange, pattern: 'dashed' },
  derivative: { colorblindColor: colorblindPalette.aqua, pattern: 'dotted' },
  sum: { colorblindColor: colorblindPalette.grey, pattern: 'dashdot' },
  output: { colorblindColor: colorblindPalette.white, pattern: 'solid' },
};

const STORAGE_KEY = 'self-driving-playground:colorblind-charts:v1';
const listeners = new Set<() => void>();
let colorblindCharts = readStoredPreference();

function readStoredPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setColorblindCharts(enabled: boolean): void {
  colorblindCharts = enabled;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage errors, such as private browsing restrictions or quota limits.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useColorblindCharts(): boolean {
  return useSyncExternalStore(subscribe, () => colorblindCharts);
}
