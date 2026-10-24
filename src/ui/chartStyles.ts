import { useSyncExternalStore } from 'react';
import type { PidSeries } from './pidHistory';
import type { ChartSeries } from './TelemetryChart';

/**
 * Line pattern used as a secondary cue in colorblind-friendly mode. Colour alone cannot keep
 * more than three overlapping lines distinct for colour-vision deficiencies, so patterns carry it.
 */
export type LinePattern = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'longdash' | 'dashdotdot' | 'shortdash';

export const linePatternDash: Record<LinePattern, number[] | undefined> = {
  solid: undefined,
  dashed: [6, 4],
  dotted: [1.5, 3],
  dashdot: [8, 3, 2, 3],
  longdash: [14, 4],
  dashdotdot: [8, 3, 2, 3, 2, 3],
  shortdash: [3, 3],
};

/** Colour and dash for a series in the current chart mode. `pattern` only applies in colorblind-friendly mode. */
export function seriesStyle(item: ChartSeries, colorblind: boolean): { color: string; dash?: number[] } {
  if (!colorblind) return { color: item.color, dash: item.defaultPattern && linePatternDash[item.defaultPattern] };
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

/** Colorblind-friendly encoding for each PID term in the per-controller graphs. */
export const pidTermColorblindStyle: Record<PidSeries, { colorblindColor: string; pattern: LinePattern }> = {
  error: { colorblindColor: colorblindPalette.yellow, pattern: 'solid' },
  proportional: { colorblindColor: colorblindPalette.blue, pattern: 'solid' },
  integral: { colorblindColor: colorblindPalette.orange, pattern: 'dashed' },
  derivative: { colorblindColor: colorblindPalette.aqua, pattern: 'dotted' },
  sum: { colorblindColor: colorblindPalette.grey, pattern: 'dashdot' },
  output: { colorblindColor: colorblindPalette.white, pattern: 'solid' },
};

const chartPalette = ['#38bdf8', '#fbbf24', '#34d399', '#fb7185', '#c4b5fd', '#e2e8f0', '#fb923c'];
const cb = colorblindPalette;
const colorblindSlotColors = [cb.blue, cb.orange, cb.aqua, cb.yellow, cb.magenta, cb.green, cb.violet, cb.red];
const slotPatterns: LinePattern[] = ['solid', 'dashed', 'dotted', 'dashdot', 'longdash', 'dashdotdot', 'shortdash'];

/**
 * Style for the `slot`-th line on a chart. Every colour is used before any repeats; repeats get a new dash.
 * Colorblind-friendly mode varies the dash alongside the colour, and shifts it each lap so pairs stay unique.
 * Pairs are unique for the first 49 lines (56 in colorblind-friendly mode); past that, styles repeat and
 * only the legend and tooltip tell lines apart.
 */
export function slotStyle(slot: number): Pick<ChartSeries, 'color' | 'defaultPattern' | 'colorblindColor' | 'pattern'> {
  const lap = Math.floor(slot / colorblindSlotColors.length);
  return {
    color: chartPalette[slot % chartPalette.length],
    defaultPattern: slotPatterns[Math.floor(slot / chartPalette.length) % slotPatterns.length],
    colorblindColor: colorblindSlotColors[slot % colorblindSlotColors.length],
    pattern: slotPatterns[(slot + lap) % slotPatterns.length],
  };
}

/**
 * Gives each selected key a style slot. A key keeps its slot while it stays selected,
 * so adding or removing a line never restyles the others; new keys take the lowest free slot.
 */
export function assignSlots(selected: readonly string[], previous: Readonly<Record<string, number>> = {}): Record<string, number> {
  const slots: Record<string, number> = {};
  const used = new Set<number>();
  for (const key of selected) if (previous[key] !== undefined && !used.has(previous[key])) {
    slots[key] = previous[key];
    used.add(previous[key]);
  }
  let next = 0;
  for (const key of selected) if (slots[key] === undefined) {
    while (used.has(next)) next++;
    slots[key] = next;
    used.add(next);
  }
  return slots;
}

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
