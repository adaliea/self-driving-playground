import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { RuntimeInspectionStore } from '../sandbox';
import type {
  RuntimeBindingMetadata,
  RuntimeToolboxInspection,
  RuntimeValuePreview,
} from '../sandbox/inspection';

interface ExpressionTarget {
  base: string;
  baseColumn: number;
  path: string[];
  text: string;
  startColumn: number;
  endColumn: number;
}

interface DefinitionInfo {
  fileName?: string;
  textSpan?: { start: number; length: number };
}

interface RuntimeHoverTargetBase {
  version?: number;
  expression: ExpressionTarget;
  lineNumber: number;
}

export type RuntimeHoverTarget =
  | RuntimeHoverTargetBase & {
      kind: 'toolboxCall';
      callId: string;
      callName: string;
    }
  | RuntimeHoverTargetBase & {
      kind: 'binding';
      bindingId: string;
      sourceCallId?: string;
    };

export async function provideRuntimeHover(
  monacoApi: typeof monaco,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  store: RuntimeInspectionStore,
): Promise<monaco.languages.Hover | null> {
  const target = await resolveRuntimeHoverTarget(monacoApi, model, position, store);
  return target ? runtimeHoverForTarget(monacoApi, target, store) : null;
}

export async function resolveRuntimeHoverTarget(
  monacoApi: typeof monaco,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  store: RuntimeInspectionStore,
): Promise<RuntimeHoverTarget | undefined> {
  const state = store.getState();
  const expression = expressionAtPosition(model, position);
  if (!expression || state.manifest.bindings.length === 0 && state.manifest.toolboxCalls.length === 0) return undefined;

  const hoveredOffset = model.getOffsetAt(position);
  const directCall = state.manifest.toolboxCalls.find(
    (call) => hoveredOffset >= call.span.start && hoveredOffset <= call.span.start + call.span.length,
  );
  if (directCall) {
    return {
      kind: 'toolboxCall',
      version: state.version,
      expression,
      lineNumber: position.lineNumber,
      callId: directCall.id,
      callName: directCall.name,
    };
  }

  const binding = await resolveBinding(monacoApi, model, position.lineNumber, expression, state.manifest.bindings);
  if (!binding) return undefined;
  return {
    kind: 'binding',
    version: state.version,
    expression,
    lineNumber: position.lineNumber,
    bindingId: binding.id,
    sourceCallId: binding.sourceCallId,
  };
}

export function runtimeHoverForTarget(
  monacoApi: typeof monaco,
  target: RuntimeHoverTarget,
  store: RuntimeInspectionStore,
): monaco.languages.Hover | null {
  const state = store.getState();
  if (target.version !== state.version) return null;

  if (target.kind === 'toolboxCall') {
    const inspection = state.snapshot?.toolboxCalls[target.callId];
    return hoverResult(monacoApi, target.lineNumber, target.expression, inspection
      ? formatToolboxInspection(inspection, state.running)
      : formatUnavailable(target.callName, state.version !== undefined));
  }

  const binding = state.manifest.bindings.find((candidate) => candidate.id === target.bindingId);
  if (!binding) return null;
  const observed = state.snapshot?.bindings[binding.id];
  if (!observed) {
    return hoverResult(
      monacoApi,
      target.lineNumber,
      target.expression,
      formatUnavailable(target.expression.text, state.version !== undefined),
    );
  }

  const value = previewAtPath(observed.value, target.expression.path);
  const special = binding.sourceCallId ? state.snapshot?.toolboxCalls[binding.sourceCallId] : undefined;
  const markdown = special
    ? formatToolboxInspection(special, state.running, target.expression.text, value)
    : formatGenericValue(target.expression.text, value, observed.observedAt, state.running);
  return hoverResult(monacoApi, target.lineNumber, target.expression, markdown);
}

function hoverResult(
  monacoApi: typeof monaco,
  lineNumber: number,
  target: ExpressionTarget,
  markdown: string,
): monaco.languages.Hover {
  return {
    range: new monacoApi.Range(lineNumber, target.startColumn, lineNumber, target.endColumn),
    contents: [{ value: markdown }],
  };
}

async function resolveBinding(
  monacoApi: typeof monaco,
  model: monaco.editor.ITextModel,
  lineNumber: number,
  target: ExpressionTarget,
  bindings: RuntimeBindingMetadata[],
): Promise<RuntimeBindingMetadata | undefined> {
  const basePosition = { lineNumber, column: target.baseColumn };
  const baseOffset = model.getOffsetAt(basePosition);
  const declaration = bindings.find(
    (binding) => baseOffset >= binding.declaration.start && baseOffset <= binding.declaration.start + binding.declaration.length,
  );
  if (declaration) return declaration;

  try {
    const getWorker = await monacoApi.languages.typescript.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    const definitions = (await worker.getDefinitionAtPosition(model.uri.toString(), baseOffset)) as
      | readonly DefinitionInfo[]
      | undefined;
    for (const definition of definitions ?? []) {
      if (!definition.textSpan || definition.fileName && !definition.fileName.endsWith('autopilot.ts')) continue;
      const match = bindings.find((binding) => binding.declaration.start === definition.textSpan!.start);
      if (match) return match;
    }
  } catch {
    // The built-in TypeScript hover can still render if the language worker is restarting.
  }
  return undefined;
}

function expressionAtPosition(model: monaco.editor.ITextModel, position: monaco.Position): ExpressionTarget | undefined {
  const line = model.getLineContent(position.lineNumber);
  const columnIndex = Math.max(0, position.column - 1);
  const expressionPattern = /[A-Za-z_$][\w$]*(?:(?:\?\.)[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = expressionPattern.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (columnIndex < start || columnIndex > end) continue;
    const segments = match[0].split(/\?\.|\./);
    return {
      base: segments[0],
      baseColumn: start + 1,
      path: segments.slice(1),
      text: match[0],
      startColumn: start + 1,
      endColumn: end + 1,
    };
  }
  return undefined;
}

export function previewAtPath(value: RuntimeValuePreview, path: readonly string[]): RuntimeValuePreview {
  let current = value;
  for (const segment of path) {
    if (current.type === 'object') {
      current = current.properties[segment] ?? { type: 'unavailable', reason: `Property ${segment} was not captured` };
      continue;
    }
    if (current.type === 'array' && /^\d+$/.test(segment)) {
      current = current.items[Number(segment)] ?? { type: 'unavailable', reason: `Index ${segment} was not captured` };
      continue;
    }
    return { type: 'unavailable', reason: `Cannot read ${segment} from this preview` };
  }
  return current;
}

export function formatGenericValue(
  expression: string,
  value: RuntimeValuePreview,
  observedAt: number,
  running: boolean,
): string {
  return [
    '---',
    `**Runtime value** · ${runtimeStatus(observedAt, running)}`,
    '',
    '```ts',
    `${expression} = ${previewText(value)}`,
    '```',
  ].join('\n');
}

export function formatToolboxInspection(
  inspection: RuntimeToolboxInspection,
  running: boolean,
  expression?: string,
  selectedValue?: RuntimeValuePreview,
): string {
  const heading = expression ? `**${escapeMarkdown(expression)}**` : `**${inspection.name}(...)**`;
  const lines = ['---', `${heading} · ${runtimeStatus(inspection.observedAt, running)}`, ''];
  if (expression && selectedValue) lines.push('```ts', `${expression} = ${previewText(selectedValue)}`, '```', '');

  const details = inspection.details ?? {};
  switch (inspection.name) {
    case 'createPidController':
      lines.push(...formatPid(details));
      break;
    case 'analyzeLane':
      lines.push(...formatLane(details));
      break;
    case 'closestVehicleAhead':
      lines.push(...formatVehicle(details));
      break;
    case 'adaptiveCruiseTargetSpeed':
      lines.push(...formatAdaptiveCruise(details));
      break;
    case 'speedFeedforward':
      lines.push(...table([
        ['Target', speed(details.targetSpeed)],
        ['Output', signed(details.output)],
      ]));
      break;
    case 'steeringFeedforward':
      lines.push(...table([
        ['Curvature', number(details.curvature, [], 5)],
        ['Speed', speed(details.speed)],
        ['Output', signed(details.output)],
      ]));
      break;
    case 'clamp':
      lines.push(...table([
        ['Input', number(details.input)],
        ['Range', `${number(details.min)} … ${number(details.max)}`],
        ['Output', number(details.output)],
        ['Saturation', string(details.saturation)],
      ]));
      break;
  }
  return lines.join('\n');
}

function formatPid(details: Record<string, RuntimeValuePreview>): string[] {
  const debug = details.debug;
  const options = details.options;
  const output = number(debug, ['output']);
  const unclamped = number(details.unclamped);
  const outputValue = numericValueAt(debug, ['output']);
  const unclampedValue = numericValue(details.unclamped);
  const min = number(options, ['outputMin']);
  const max = number(options, ['outputMax']);
  const saturation = outputValue !== undefined && unclampedValue !== undefined && Math.abs(outputValue - unclampedValue) > 1e-7
    ? 'limited'
    : 'none';
  return [
    '**PID controller**',
    '',
    ...table([
      ['Error', number(debug, ['error'])],
      ['P / I / D', `${number(debug, ['proportional'])} / ${number(debug, ['integral'])} / ${number(debug, ['derivative'])}`],
      ['Raw → output', `${unclamped} → ${output}`],
      ['Gains', `kp ${number(options, ['kp'])}, ki ${number(options, ['ki'])}, kd ${number(options, ['kd'])}`],
      ['Output limits', `${min} … ${max}`],
      ['Saturation', saturation],
    ]),
  ];
}

function formatLane(details: Record<string, RuntimeValuePreview>): string[] {
  const offset = numericValue(details.centerOffset);
  const heading = numericValue(details.heading);
  const direction = offset === undefined || Math.abs(offset) < 0.0005 ? 'centered' : offset > 0 ? 'right of ego' : 'left of ego';
  return [
    '**Lane analysis**',
    '',
    ...table([
      ['Center offset', offset === undefined ? '—' : `${formatNumber(offset, 3)} m · ${direction}`],
      ['Heading', heading === undefined ? '—' : `${formatNumber(heading * 180 / Math.PI, 2)}° (${formatNumber(heading, 4)} rad)`],
      ['Curvature', number(details.curvature, [], 6)],
      ['Confidence', percent(details.confidence)],
      ['Relative lane', number(details.relativeTargetLane)],
    ]),
  ];
}

function formatVehicle(details: Record<string, RuntimeValuePreview>): string[] {
  const vehicle = details.vehicle;
  const relativeVy = numericValueAt(vehicle, ['relativeVy']);
  const relativeHeading = numericValueAt(vehicle, ['relativeHeading']);
  return [
    '**Closest vehicle ahead**',
    '',
    ...table([
      ['Vehicle', stringAt(vehicle, ['id'])],
      ['Relative lane', number(details.relativeLane)],
      ['Gap', distance(vehicle, ['relativeY'])],
      ['Lateral offset', distance(vehicle, ['relativeX'])],
      ['Relative yaw', relativeHeading === undefined ? '—' : `${formatNumber(relativeHeading * 180 / Math.PI, 1)}°`],
      ['Relative speed', relativeVy === undefined ? '—' : `${formatNumber(relativeVy, 2)} m/s · ${relativeVy < 0 ? 'closing' : 'opening'}`],
      ['Confidence', percentAt(vehicle, ['confidence'])],
    ]),
  ];
}

function formatAdaptiveCruise(details: Record<string, RuntimeValuePreview>): string[] {
  const lead = details.lead;
  return [
    '**Adaptive cruise**',
    '',
    ...table([
      ['Mode', string(details.mode)],
      ['Free-road speed', speed(details.freeRoadSpeed)],
      ['Target speed', speed(details.targetSpeed)],
      ['Lead vehicle', stringAt(lead, ['id'])],
      ['Actual / target gap', `${distance(lead, ['relativeY'])} / ${distance(details.targetGap)}`],
    ]),
  ];
}

function formatUnavailable(expression: string, loaded: boolean): string {
  return ['---', `**${escapeMarkdown(expression)}**`, '', loaded ? '_Waiting for this value to execute._' : '_Waiting for code to load._'].join('\n');
}

function table(rows: Array<[string, string]>): string[] {
  return ['| Runtime detail | Value |', '| --- | ---: |', ...rows.map(([label, value]) => `| ${label} | ${escapeTable(value)} |`)];
}

function previewText(value: RuntimeValuePreview, depth = 0): string {
  switch (value.type) {
    case 'undefined': return 'undefined';
    case 'null': return 'null';
    case 'boolean': return String(value.value);
    case 'number': return typeof value.value === 'number' ? formatNumber(value.value, 5) : value.value;
    case 'bigint': return `${value.value}n`;
    case 'string': return `${JSON.stringify(value.value)}${value.truncated ? '…' : ''}`;
    case 'function': return `[Function${value.name ? ` ${value.name}` : ''}]`;
    case 'symbol': return value.value;
    case 'reference': return `[Reference ${value.path}]`;
    case 'unavailable': return `[Unavailable: ${value.reason}]`;
    case 'array': {
      if (depth >= 2) return `Array(${value.length})`;
      const items = value.items.slice(0, 6).map((item) => previewText(item, depth + 1));
      return `[${items.join(', ')}${value.truncated || value.length > items.length ? ', …' : ''}]`;
    }
    case 'object': {
      if (depth >= 2) return value.name ? `[${value.name}]` : '{…}';
      const entries = Object.entries(value.properties).slice(0, 8);
      return `{ ${entries.map(([key, item]) => `${key}: ${previewText(item, depth + 1)}`).join(', ')}${value.truncated ? ', …' : ''} }`;
    }
  }
}

function runtimeStatus(observedAt: number, running: boolean): string {
  const age = Math.max(0, Date.now() - observedAt);
  const ageText = age < 100 ? 'just now' : age < 1000 ? `${Math.round(age / 10) * 10} ms ago` : `${(age / 1000).toFixed(1)} s ago`;
  return `${running ? 'Running' : 'Paused'} · observed ${ageText}`;
}

function number(value: RuntimeValuePreview | undefined, path: string[] = [], digits = 4): string {
  const numeric = numericValueAt(value, path);
  return numeric === undefined ? '—' : formatNumber(numeric, digits);
}

function signed(value: RuntimeValuePreview | undefined): string {
  const numeric = numericValue(value);
  return numeric === undefined ? '—' : `${numeric >= 0 ? '+' : ''}${formatNumber(numeric, 4)}`;
}

function speed(value: RuntimeValuePreview | undefined): string {
  const numeric = numericValue(value);
  return numeric === undefined ? '—' : `${formatNumber(numeric, 2)} m/s · ${formatNumber(numeric * 2.2369362921, 1)} mph`;
}

function distance(value: RuntimeValuePreview | undefined, path: string[] = []): string {
  const numeric = numericValueAt(value, path);
  return numeric === undefined ? '—' : `${formatNumber(numeric, 2)} m`;
}

function percent(value: RuntimeValuePreview | undefined): string {
  const numeric = numericValue(value);
  return numeric === undefined ? '—' : `${formatNumber(numeric * 100, 1)}%`;
}

function percentAt(value: RuntimeValuePreview | undefined, path: string[]): string {
  return percent(previewAtPath(value ?? { type: 'undefined' }, path));
}

function string(value: RuntimeValuePreview | undefined): string {
  if (!value) return '—';
  if (value.type === 'string') return value.value;
  if (value.type === 'undefined' || value.type === 'null') return '—';
  return previewText(value);
}

function stringAt(value: RuntimeValuePreview | undefined, path: string[]): string {
  return string(previewAtPath(value ?? { type: 'undefined' }, path));
}

function numericValue(value: RuntimeValuePreview | undefined): number | undefined {
  return value?.type === 'number' && typeof value.value === 'number' ? value.value : undefined;
}

function numericValueAt(value: RuntimeValuePreview | undefined, path: string[]): number | undefined {
  return numericValue(previewAtPath(value ?? { type: 'undefined' }, path));
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-5)) return value.toExponential(Math.min(digits, 4));
  return Number(value.toFixed(digits)).toString();
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!-]/g, '\\$&');
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
