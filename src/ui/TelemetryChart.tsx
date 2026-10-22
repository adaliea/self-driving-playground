import { useEffect, useRef } from 'react';
import { init, use, type EChartsType } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, ToolboxComponent, AxisPointerComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { PID_HISTORY_MS } from './pidHistory';
import { seriesStyle, useColorblindCharts, type LinePattern } from './chartStyles';
import { PlaybackClock } from './playbackClock';

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, ToolboxComponent, AxisPointerComponent, CanvasRenderer]);

export interface ChartSample { time: number; values: Partial<Record<string, number>> }
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  axis?: string;
  /** Used instead of `color`, together with `pattern`, when colorblind-friendly charts are on. */
  colorblindColor?: string;
  pattern?: LinePattern;
}
/** Seconds of recent history shown before the user zooms; the slider still reaches the full history. */
const DEFAULT_VISIBLE_SECONDS = PID_HISTORY_MS / 1000 / 4;

export interface ChartPanel { keys: string[]; top: number; bottom: number; label: string; nonnegative?: boolean }

export function TelemetryChart({ name, history, series, panels, note, height = 360, legend = false }: {
  name: string;
  history: ChartSample[];
  series: ChartSeries[];
  panels?: ChartPanel[];
  note: string;
  /** Pixel height, or `'fill'` to take the remaining height of a flex column parent. */
  height?: number | 'fill';
  /** Show a key of line colours and patterns below the chart. */
  legend?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType>();
  const colorblind = useColorblindCharts();
  // Keep the default window pinned to the newest samples until the user zooms or pans.
  const followLatest = useRef(true);
  // Data arrives at ~10 Hz; the clock lets the time window slide every frame in between.
  const clock = useRef(new PlaybackClock());
  const startAnimation = useRef<() => void>(() => {});
  const smooth = useRef(true);
  const viewEnd = () => smooth.current ? clock.current.current() : historyEnd(latest.current.history);
  const latest = useRef({ history, series, panels, colorblind, followLatest: true });
  latest.current = { history, series, panels, colorblind, followLatest: followLatest.current };
  useEffect(() => {
    const element = container.current!;
    // A popped-out chart must use its own window's clock and frames.
    const ownerWindow = element.ownerDocument.defaultView ?? window;
    smooth.current = !ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let lastFrameTime = 0;
    const animate = (now: number) => {
      frame = 0;
      const chart = instance.current;
      if (!chart) return;
      const view = clock.current.tick(now, Math.min(0.1, (now - lastFrameTime) / 1000));
      lastFrameTime = now;
      updateWindow(chart, view, followLatest.current);
      if (!clock.current.settled(ownerWindow.performance.now())) frame = ownerWindow.requestAnimationFrame(animate);
    };
    startAnimation.current = () => {
      if (!smooth.current || frame) return;
      lastFrameTime = ownerWindow.performance.now();
      frame = ownerWindow.requestAnimationFrame(animate);
    };
    clock.current.push(historyEnd(latest.current.history), ownerWindow.performance.now());
    const update = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      if (!instance.current) {
        instance.current = init(element, undefined, { renderer: 'canvas' });
        instance.current.setOption({
          animation: false,
          textStyle: { fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif' },
          tooltip: { trigger: 'axis', confine: true, renderMode: 'richText', backgroundColor: '#0f1315', borderColor: '#253033', textStyle: { color: '#dde5e6', fontSize: 11 } },
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          toolbox: { top: 0, right: 12, iconStyle: { borderColor: '#8a999c' }, feature: { dataZoom: { yAxisIndex: 'none' }, saveAsImage: { backgroundColor: '#070b0d', title: 'Save graph image' } } },
          dataZoom: [{ id: 'inside', type: 'inside', xAxisIndex: [0], filterMode: 'none' }, { id: 'slider', type: 'slider', xAxisIndex: [0], bottom: 8, height: 22, borderColor: '#253033', textStyle: { color: '#8a999c' }, fillerColor: 'rgba(109,247,209,0.08)' }],
        });
        // Only user zoom actions emit this; option updates from updateData do not.
        instance.current.on('datazoom', () => { followLatest.current = false; });
      }
      instance.current.resize();
      updateData(instance.current, { ...latest.current, viewEnd: viewEnd() });
    };
    // Use the observer from the chart's own window so resizes register in a popped-out window too.
    const OwnerResizeObserver = element.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    const observer = new OwnerResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      ownerWindow.cancelAnimationFrame(frame);
      startAnimation.current = () => {};
      observer.disconnect();
      instance.current?.dispose();
      instance.current = undefined;
    };
  }, []);
  useEffect(() => {
    const ownerWindow = container.current?.ownerDocument.defaultView ?? window;
    clock.current.push(historyEnd(history), ownerWindow.performance.now());
    if (instance.current) updateData(instance.current, { history, series, panels, colorblind, followLatest: followLatest.current, viewEnd: viewEnd() });
    startAnimation.current();
  }, [history, series, panels, colorblind]);
  const fill = height === 'fill';
  return <div className={fill ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'min-w-0'}>
    <div ref={container} role="img" aria-label={`${name}: ${series.map((item) => item.label).join(', ') || 'no signals selected'}`} style={fill ? undefined : { height }} className={fill ? 'min-h-0 w-full min-w-0 flex-1' : 'w-full min-w-0'} />
    {legend ? (
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 px-1 pb-1 text-xs text-muted-foreground">
        {series.map((item) => <li key={item.key} className="flex items-center gap-1.5"><LineSwatch series={item} colorblind={colorblind} />{item.label}</li>)}
      </ul>
    ) : null}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{note}</span>
      <button type="button" className="rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => {
        followLatest.current = true;
        if (instance.current) updateData(instance.current, { ...latest.current, followLatest: true, viewEnd: viewEnd() });
      }}>Reset zoom</button>
    </div>
  </div>;
}

export function LineSwatch({ series, colorblind }: { series: ChartSeries; colorblind: boolean }) {
  const { color, dash } = seriesStyle(series, colorblind);
  return (
    <svg aria-hidden="true" width="18" height="6" viewBox="0 0 18 6" className="shrink-0">
      <line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeWidth={colorblind ? 1.75 : 1.5} strokeLinecap="round" strokeDasharray={dash?.join(' ')} />
    </svg>
  );
}

const chartLayouts = new WeakMap<EChartsType, string>();

const chartAxisCounts = new WeakMap<EChartsType, number>();

function historyEnd(history: ChartSample[]): number {
  return (history[history.length - 1]?.time ?? 0) / 1000;
}

/** Time-axis bounds for a window ending at `end` seconds, and the zoom that shows its newest part. */
function timeWindow(end: number) {
  const axisMin = Math.max(0, end - PID_HISTORY_MS / 1000);
  const axisMax = Math.max(1, end);
  return { axisMin, axisMax, defaultZoomStart: Math.max(0, 100 * (1 - DEFAULT_VISIBLE_SECONDS / (axisMax - axisMin))) };
}

/** Slides the time window only; cheap enough to run every animation frame. */
function updateWindow(chart: EChartsType, end: number, followLatest: boolean) {
  const { axisMin, axisMax, defaultZoomStart } = timeWindow(end);
  chart.setOption({
    xAxis: Array.from({ length: chartAxisCounts.get(chart) ?? 1 }, (_, index) => ({ id: `x-${index}`, min: axisMin, max: axisMax })),
    ...(followLatest ? { dataZoom: ['inside', 'slider'].map((id) => ({ id, start: defaultZoomStart, end: 100 })) } : {}),
  });
}

function updateData(chart: EChartsType, { history, series, panels, colorblind, followLatest, viewEnd }: {
  history: ChartSample[]; series: ChartSeries[]; panels?: ChartPanel[]; colorblind: boolean; followLatest: boolean; viewEnd: number;
}) {
  const { axisMin, axisMax, defaultZoomStart } = timeWindow(viewEnd);
  const axisGroups = [...new Set(series.map((item) => item.axis ?? 'Value'))];
  if (!axisGroups.length) axisGroups.push('Value');
  const split = !!panels && panels.length > 1;
  const axes = split ? panels!.map((panel) => panel.label) : axisGroups;
  const visibleAxisCount = chart.getWidth() < 600 ? Math.min(2, axes.length) : axes.length;
  const gridCount = split ? panels!.length : 1;
  // Replacing grids and axes discards the models the tooltip and zoom slider hold mid-interaction,
  // so only replace them when the chart's structure changes. Data updates merge in place by id.
  const layout = JSON.stringify([gridCount, axes, visibleAxisCount, series.map((item) => item.key)]);
  const layoutChanged = chartLayouts.get(chart) !== layout;
  chartLayouts.set(chart, layout);
  chartAxisCounts.set(chart, gridCount);
  chart.setOption({
    dataZoom: ['inside', 'slider'].map((id) => ({
      id, xAxisIndex: Array.from({ length: gridCount }, (_, index) => index),
      ...(followLatest ? { start: defaultZoomStart, end: 100 } : {}),
    })),
    grid: Array.from({ length: gridCount }, (_, index) => ({
      id: `grid-${index}`, left: 52, right: split ? 24 : visibleAxisCount > 1 ? 65 + (visibleAxisCount - 2) * 48 : 24,
      top: split ? `${12 + index * 38}%` : 64,
      ...(split ? { height: '27%' } : { bottom: 66 }),
    })),
    xAxis: Array.from({ length: gridCount }, (_, index) => ({
      id: `x-${index}`, type: 'value', gridIndex: index, min: axisMin, max: axisMax,
      // Split panels share one time axis, so only the bottom panel labels it.
      // The window edges move every frame, so only label the round ticks inside it.
      axisLabel: { show: index === gridCount - 1, hideOverlap: true, showMinLabel: false, showMaxLabel: false, color: '#8a999c', fontSize: 10, formatter: (value: number) => `${value.toFixed(1)}s` },
      axisLine: { lineStyle: { color: '#253033' } }, splitLine: { show: false },
      axisPointer: { label: { formatter: ({ value }: { value: number }) => `${value.toFixed(2)} s` } },
    })),
    yAxis: axes.map((axis, index) => ({
      id: `y-${index}`, show: split || index < visibleAxisCount, type: 'value', gridIndex: split ? index : 0, name: axis, nameTextStyle: { color: '#8a999c', fontSize: 10 },
      position: split || index === 0 ? 'left' : 'right', offset: split || index < 2 ? 0 : (index - 1) * 48,
      axisLabel: { color: '#8a999c', fontSize: 10, formatter: (value: number) => Math.abs(value) >= 1000 ? value.toExponential(1) : Number(value.toPrecision(3)).toString() },
      splitLine: { show: split || index === 0, lineStyle: { color: '#182124', width: 0.5 } },
    })),
    series: series.map((item) => {
      const style = seriesStyle(item, colorblind);
      const index = split ? Math.max(0, panels!.findIndex((panel) => panel.keys.includes(item.key))) : axisGroups.indexOf(item.axis ?? 'Value');
      return {
        id: item.key, name: item.axis ? `${item.label} [${item.axis}]` : item.label, type: 'line', showSymbol: false, connectNulls: false,
        xAxisIndex: split ? index : 0, yAxisIndex: index,
        lineStyle: { color: style.color, width: colorblind ? 1.5 : 1, type: style.dash ?? 'solid', cap: 'round' }, itemStyle: { color: style.color },
        emphasis: { disabled: true },
        data: history.map((sample) => [sample.time / 1000, Number.isFinite(sample.values[item.key]) ? sample.values[item.key] : null]),
      };
    }),
  }, { replaceMerge: layoutChanged ? ['series', 'xAxis', 'yAxis', 'grid'] : [], lazyUpdate: true });
}
