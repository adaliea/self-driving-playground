import { useEffect, useRef } from 'react';
import { init, use, type EChartsType } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, ToolboxComponent, AxisPointerComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { PID_HISTORY_MS } from './pidHistory';

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, ToolboxComponent, AxisPointerComponent, CanvasRenderer]);

export interface ChartSample { time: number; values: Partial<Record<string, number>> }
export interface ChartSeries { key: string; label: string; color: string; dash?: string; axis?: string }
export interface ChartPanel { keys: string[]; top: number; bottom: number; label: string; nonnegative?: boolean }

export function TelemetryChart({ name, history, series, panels, note, height = 360 }: {
  name: string;
  history: ChartSample[];
  series: ChartSeries[];
  panels?: ChartPanel[];
  note: string;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType>();
  const latest = useRef({ history, series, panels });
  latest.current = { history, series, panels };
  useEffect(() => {
    const element = container.current!;
    const update = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      if (!instance.current) {
        instance.current = init(element, undefined, { renderer: 'canvas' });
        instance.current.setOption({
          animation: false,
          tooltip: { trigger: 'axis', confine: true, renderMode: 'richText', backgroundColor: '#18181b', borderColor: '#3f3f46', textStyle: { color: '#e4e4e7', fontSize: 11 } },
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          toolbox: { top: 0, right: 12, iconStyle: { borderColor: '#a1a1aa' }, feature: { dataZoom: { yAxisIndex: 'none' }, saveAsImage: { backgroundColor: '#09090b', title: 'Save graph image' } } },
          dataZoom: [{ id: 'inside', type: 'inside', xAxisIndex: [0], filterMode: 'none' }, { id: 'slider', type: 'slider', xAxisIndex: [0], bottom: 8, height: 22, borderColor: '#3f3f46', textStyle: { color: '#a1a1aa' }, fillerColor: 'rgba(56,189,248,0.12)' }],
        });
      }
      instance.current.resize();
      updateData(instance.current, latest.current);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => { observer.disconnect(); instance.current?.dispose(); instance.current = undefined; };
  }, []);
  useEffect(() => {
    if (instance.current) updateData(instance.current, { history, series, panels });
  }, [history, series, panels]);
  return <div className="min-w-0">
    <div ref={container} role="img" aria-label={`${name}: ${series.map((item) => item.label).join(', ') || 'no signals selected'}`} style={{ height }} className="w-full min-w-0" />
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{note}</span>
      <button type="button" className="rounded px-2 py-1 text-sky-300 hover:bg-accent" onClick={() => instance.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })}>Reset zoom</button>
    </div>
  </div>;
}

function updateData(chart: EChartsType, { history, series, panels }: { history: ChartSample[]; series: ChartSeries[]; panels?: ChartPanel[] }) {
  const end = (history[history.length - 1]?.time ?? 0) / 1000;
  const axisGroups = [...new Set(series.map((item) => item.axis ?? 'Value'))];
  if (!axisGroups.length) axisGroups.push('Value');
  const split = !!panels && panels.length > 1;
  const axes = split ? panels!.map((panel) => panel.label) : axisGroups;
  const visibleAxisCount = chart.getWidth() < 600 ? Math.min(2, axes.length) : axes.length;
  const gridCount = split ? panels!.length : 1;
  chart.setOption({
    dataZoom: ['inside', 'slider'].map((id) => ({ id, xAxisIndex: Array.from({ length: gridCount }, (_, index) => index) })),
    grid: Array.from({ length: gridCount }, (_, index) => ({
      left: 52, right: split ? 24 : visibleAxisCount > 1 ? 65 + (visibleAxisCount - 2) * 48 : 24,
      top: split ? `${12 + index * 38}%` : 44,
      ...(split ? { height: '27%' } : { bottom: 66 }),
    })),
    xAxis: Array.from({ length: gridCount }, (_, index) => ({
      type: 'value', gridIndex: index, min: Math.max(0, end - PID_HISTORY_MS / 1000), max: Math.max(1, end),
      axisLabel: { color: '#a1a1aa', fontSize: 10, formatter: (value: number) => `${value.toFixed(1)}s` },
      axisLine: { lineStyle: { color: '#3f3f46' } }, splitLine: { show: false },
      axisPointer: { label: { formatter: ({ value }: { value: number }) => `${value.toFixed(2)} s` } },
    })),
    yAxis: axes.map((axis, index) => ({
      show: split || index < visibleAxisCount, type: 'value', gridIndex: split ? index : 0, name: axis, nameTextStyle: { color: '#a1a1aa', fontSize: 10 },
      position: split || index === 0 ? 'left' : 'right', offset: split || index < 2 ? 0 : (index - 1) * 48,
      axisLabel: { color: '#a1a1aa', fontSize: 10, formatter: (value: number) => Math.abs(value) >= 1000 ? value.toExponential(1) : Number(value.toPrecision(3)).toString() },
      splitLine: { show: split || index === 0, lineStyle: { color: '#27272a', width: 0.5 } },
    })),
    series: series.map((item) => {
      const index = split ? Math.max(0, panels!.findIndex((panel) => panel.keys.includes(item.key))) : axisGroups.indexOf(item.axis ?? 'Value');
      return {
        id: item.key, name: item.axis ? `${item.label} [${item.axis}]` : item.label, type: 'line', showSymbol: false, connectNulls: false,
        xAxisIndex: split ? index : 0, yAxisIndex: index,
        lineStyle: { color: item.color, width: 1, type: item.dash ? 'dashed' : 'solid' }, itemStyle: { color: item.color },
        emphasis: { disabled: true },
        data: history.map((sample) => [sample.time / 1000, Number.isFinite(sample.values[item.key]) ? sample.values[item.key] : null]),
      };
    }),
  }, { replaceMerge: ['series', 'xAxis', 'yAxis', 'grid'], lazyUpdate: true });
}
