import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { LockKeyhole, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { editor } from 'monaco-editor/esm/vs/editor/editor.api';
import * as monacoEditor from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { CompileWarning, RuntimeInspectionStore } from '../sandbox';
import type { ControllerExample } from '../toolbox';
import { publicAutopilotDts } from '../types/publicDts';
import { RuntimeValueWidget } from './RuntimeValueWidget';

type MonacoWorkerGlobal = typeof self & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, label: string) => Worker;
  };
};

(self as MonacoWorkerGlobal).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => {
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco: monacoEditor });

type MonacoApi = Parameters<BeforeMount>[0];

const autopilotModelUri = 'file:///autopilot.ts';
const autopilotApiDtsUri = 'file:///autopilot-api.d.ts';
const toolboxModelUri = 'file:///autopilot-toolbox.ts';

type ActiveEditorFile = 'autopilot' | 'api' | 'toolbox';
type EditorLocation =
  | {
      lineNumber: number;
      column: number;
    }
  | {
      startLineNumber: number;
      startColumn: number;
      endLineNumber?: number;
      endColumn?: number;
    };

const autopilotHoverDocs: Record<string, string> = {
  AutopilotInput: [
    '**AutopilotInput**',
    '',
    'The sensor snapshot passed to `autopilot(input)` on each control tick.',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `dt` | Fixed simulation timestep in seconds. Use this for PID integration and derivatives. |',
    '| `ego` | Current ego speed, heading, sideways velocity, and lane index. |',
    '| `vehicles` | Stable filtered tracks, including velocity and uncertainty. |',
    '| `vehicleMeasurements` | Raw noisy observations before tracking; these may drop out. |',
    '| `laneLines` | Left/right/far lane-line sample points relative to ego. |',
  ].join('\n'),
  AutopilotOutput: [
    '**AutopilotOutput**',
    '',
    'The normalized command returned by user code.',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `motor` | `-1` full braking, `0` coast, `1` full acceleration. |',
    '| `steering` | `-1` max left, `0` straight, `1` max right. |',
    '| `debug` | Optional PID telemetry for the UI. It never affects physics. |',
    '',
    'The simulator clamps invalid motor and steering values defensively.',
  ].join('\n'),
  EgoState: [
    '**EgoState**',
    '',
    'Basic state of the controlled car.',
    '',
    '`speed` is meters per second. `heading` is radians relative to the road/world frame (positive points right). `lateralVelocity` is sideways speed across the road in m/s (positive is moving right). `yawRate` is the world turn rate in radians per second (positive is right), including road curvature. `laneIndex` is `0`, `1`, or `2` on the current 3-lane road.',
  ].join('\n'),
  VehicleMeasurement: [
    '**VehicleMeasurement**',
    '',
    'One raw, intermittent oriented-box observation before temporal tracking.',
    '',
    '`relativeX` is lateral meters from ego: negative is left, positive is right. `relativeY` is longitudinal meters: positive is ahead, negative is behind.',
    '',
    'Measurements contain pose, size, confidence, and estimated sensor uncertainty—but no filtered velocity.',
  ].join('\n'),
  VehicleTrack: [
    '**VehicleTrack**',
    '',
    'The perception tracker\'s stable estimate for a nearby vehicle.',
    '',
    'In addition to the filtered oriented box and relative velocity, tracks expose age, time since the last measurement, prediction status, and uncertainty.',
    '',
    'A track can remain in `input.vehicles` during a short raw-measurement dropout.',
    '',
    'Vehicles carry no lane number. Use `closestVehicleAhead(input.vehicles, input.laneLines)`, which counts a vehicle as in a lane when any part of its bounding box overlaps it, to find lead vehicles for adaptive cruise control.',
  ].join('\n'),
  LaneLineDetections: [
    '**LaneLineDetections**',
    '',
    'Lane-line sample groups around the ego lane.',
    '',
    '`left` and `right` bound the current lane. `farLeft` and `farRight` are included for adjacent-lane analysis and future lane changes.',
  ].join('\n'),
  LaneLineSample: [
    '**LaneLineSample**',
    '',
    'One detected lane-line point in ego-relative coordinates.',
    '',
    '`x` is lateral meters, `y` is forward meters, and `confidence` is sensor quality from `0` to `1`.',
  ].join('\n'),
  LaneAnalysis: [
    '**LaneAnalysis**',
    '',
    'Interpreted lane geometry returned by `analyzeLane(...)`.',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `centerOffset` | Lateral offset from target lane center in meters. |',
    '| `heading` | Lane heading error in radians, at ego in local mode or ahead in preview mode. |',
    '| `curvature` | Signed lane curvature in 1/m (positive curves right), at ego in local mode or ahead in preview mode. |',
    '| `confidence` | Aggregate quality of the lane samples used for the fit. |',
  ].join('\n'),
  graph: [
    '**graph(name, value, unit?)**',
    '',
    'Plots `value` in the Telemetry graphs, one point per autopilot call. New series are added to every graph tab the first time they appear.',
    '',
    'Series with the same `unit` share a y-axis; without one each series gets its own scale. Booleans plot as 0/1. Returns `value`, so it can wrap an expression: `const error = graph("lane offset", lane.centerOffset, "m");`',
  ].join('\n'),
  clamp: [
    '**clamp(value, min, max)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Constrains a number to the provided minimum and maximum values.',
  ].join('\n'),
  createPidController: [
    '**createPidController(options)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Creates a stateful PID controller with output limits, optional integral limits, derivative smoothing, reset, and debug terms.',
    '',
    'Create it once, above `autopilot`, so it remembers its integral and previous error between ticks.',
  ].join('\n'),
  analyzeLane: [
    '**analyzeLane(laneLines, relativeTargetLane?, mode?)**',
    '',
    'Built-in helper available inside user code.',
    '',
    'Fits a smooth curve through the nearest 3–21 meters of lane samples and estimates center offset, heading, and curvature at ego for steering.',
    '',
    'Pass `-1` or `1` as `relativeTargetLane` to read an adjacent lane, for example during a lane change. Pass `"preview"` as the third argument for a longer 5–56 meter fit when planning speed.',
  ].join('\n'),
  steeringFeedforward: [
    '**steeringFeedforward(curvature, speed)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Estimates the steering command that follows a curve of the given curvature at the given speed. Add PID feedback on the lane error to correct the rest.',
  ].join('\n'),
  lateralVelocitySteering: [
    '**lateralVelocitySteering(input, targetLateralVelocity)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Steers so the car moves sideways at `targetLateralVelocity` m/s (positive is right). It is the inner loop of a cascade: choose the sideways speed yourself, for example with a PID on `lane.centerOffset`. This is the controller "Steer for me" uses.',
  ].join('\n'),
  speedFeedforward: [
    '**speedFeedforward(targetSpeed)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Estimates the motor command that holds `targetSpeed` steady against drag. Add PID feedback on the speed error to reach the speed and remove the leftover error.',
  ].join('\n'),
  adaptiveCruiseTargetSpeed: [
    '**adaptiveCruiseTargetSpeed(input, freeRoadSpeed, relativeLane?)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Reduces target speed when the closest vehicle ahead is inside the desired following gap.',
  ].join('\n'),
  createLaneChooser: [
    '**createLaneChooser(options?)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Creates a stateful chooser. Call `update(input)` once per tick; it returns the lane to steer toward relative to ego (`-1` left, `0` current, `1` right).',
    '',
    'An adjacent lane is chosen only when its traffic is faster than the current lane by at least `options.minSpeedGain` m/s (default 2) and there is room to merge. Your steering has to follow it, e.g. `analyzeLane(input.laneLines, relativeLane)`.',
  ].join('\n'),
  PidDebugTerms: [
    '**PidDebugTerms**',
    '',
    'Optional PID telemetry shown in the panel below the simulator.',
    '',
    '`error`, `proportional`, `integral`, `derivative`, and `output` should be the terms from your controller. These values are display-only.',
  ].join('\n'),
  AutopilotDebug: [
    '**AutopilotDebug**',
    '',
    'Optional debug payload returned as `output.debug`.',
    '',
    'PID terms appear automatically using controller variable names. These fields remain available for custom controllers.',
  ].join('\n'),
};

let autopilotHoverProviderRegistered = false;
let publicAutopilotDtsRegistered = false;

function registerAutopilotHoverProvider(monaco: MonacoApi): void {
  if (autopilotHoverProviderRegistered) return;
  autopilotHoverProviderRegistered = true;

  monaco.languages.registerHoverProvider('typescript', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const value = autopilotHoverDocs[word.word];
      if (!value) return null;

      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value }],
      };
    },
  });
}

function ensurePublicApiModel(monaco: MonacoApi): void {
  const uri = monaco.Uri.parse(autopilotApiDtsUri);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== publicAutopilotDts) existing.setValue(publicAutopilotDts);
    return;
  }

  monaco.editor.createModel(publicAutopilotDts, 'typescript', uri);
}

function registerPublicAutopilotDts(monaco: MonacoApi): void {
  if (publicAutopilotDtsRegistered) return;
  publicAutopilotDtsRegistered = true;
  monaco.languages.typescript.typescriptDefaults.addExtraLib(publicAutopilotDts, autopilotApiDtsUri);
}

function ensureToolboxModel(monaco: Pick<MonacoApi, 'editor' | 'Uri'>, source: string): void {
  const uri = monaco.Uri.parse(toolboxModelUri);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== source) existing.setValue(source);
    return;
  }

  monaco.editor.createModel(source, 'typescript', uri);
}

function editorFileForUri(resource: monacoEditor.Uri): ActiveEditorFile | undefined {
  if (resource.toString() === autopilotApiDtsUri || resource.path === '/autopilot-api.d.ts') return 'api';
  if (resource.toString() === toolboxModelUri || resource.path === '/autopilot-toolbox.ts') return 'toolbox';
  if (resource.toString() === autopilotModelUri || resource.path === '/autopilot.ts') return 'autopilot';
  return undefined;
}

function revealEditorLocation(editorInstance: editor.ICodeEditor, location?: EditorLocation): void {
  if (!location) return;

  if ('startLineNumber' in location) {
    const range = {
      startLineNumber: location.startLineNumber,
      startColumn: location.startColumn,
      endLineNumber: location.endLineNumber ?? location.startLineNumber,
      endColumn: location.endColumn ?? location.startColumn,
    };
    editorInstance.setSelection(range);
    editorInstance.revealRangeInCenter(range);
    return;
  }

  editorInstance.setPosition(location);
  editorInstance.revealPositionInCenter(location);
}

interface EditorPanelProps {
  code: string;
  examples: ControllerExample[];
  selectedExampleId: string;
  compileErrors: string[];
  /** Likely mistakes in Autopilot.ts, shown as warning squiggles. */
  compileWarnings: CompileWarning[];
  /** Toolbox source to show and type-check against: helpers the presenter hasn't locked. */
  toolboxSource: string;
  codeStatus: string;
  inspectionStore: RuntimeInspectionStore;
  /**
   * Renders the toolbox menu. `insertAtCursor` adds code at the Autopilot.ts cursor,
   * and puts any `setup` declarations not already in the file above autopilot(input).
   */
  renderToolbox: (insertAtCursor: (code: string, setup?: string[]) => void) => ReactNode;
  onCodeChange: (code: string) => void;
  onLoadExample: (id: string) => void;
}

export function EditorPanel({
  code,
  examples,
  selectedExampleId,
  compileErrors,
  compileWarnings,
  toolboxSource,
  codeStatus,
  inspectionStore,
  renderToolbox,
  onCodeChange,
  onLoadExample,
}: EditorPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const editorOpenerRef = useRef<monacoEditor.IDisposable | null>(null);
  const runtimeHoverDisposablesRef = useRef<monacoEditor.IDisposable[]>([]);
  const pendingRevealRef = useRef<EditorLocation>();
  // Until someone clicks into the code, the cursor sits at line 1, so inserts append instead.
  const hasPlacedCursorRef = useRef(false);
  const toolboxSourceRef = useRef(toolboxSource);
  toolboxSourceRef.current = toolboxSource;
  const [activeFile, setActiveFile] = useState<ActiveEditorFile>('autopilot');
  const isToolboxActive = activeFile === 'toolbox';
  const isApiActive = activeFile === 'api';
  const isReadOnly = activeFile !== 'autopilot';
  const hasSelectedExample = examples.some((example) => example.id === selectedExampleId);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      allowNonTsExtensions: true,
      strict: true,
      noEmit: true,
      isolatedModules: true,
    });
    registerPublicAutopilotDts(monaco);
    ensurePublicApiModel(monaco);
    ensureToolboxModel(monaco, toolboxSourceRef.current);
    registerAutopilotHoverProvider(monaco);
    monaco.editor.defineTheme('autopilot-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6b7c80' },
        { token: 'keyword', foreground: '89a9ff' },
        { token: 'number', foreground: 'f7c86d' },
        { token: 'string', foreground: '6df7d1' },
      ],
      colors: {
        'editor.background': '#070b0d',
        'editor.foreground': '#dde5e6',
        'editorLineNumber.foreground': '#3f4d51',
        'editorLineNumber.activeForeground': '#9aa9ac',
        'editor.lineHighlightBackground': '#0e1517',
        'editor.lineHighlightBorder': '#0e1517',
        'editor.selectionBackground': '#1e3a3a',
        'editorCursor.foreground': '#6df7d1',
        'editorWidget.background': '#0e1416',
        'editorWidget.border': '#253033',
        'editorHoverWidget.background': '#0e1416',
        'editorHoverWidget.border': '#253033',
      },
    });
  };

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
    editorInstance.onDidFocusEditorText(() => {
      const model = editorInstance.getModel();
      if (model && editorFileForUri(model.uri) === 'autopilot') hasPlacedCursorRef.current = true;
    });
    editorOpenerRef.current?.dispose();
    for (const disposable of runtimeHoverDisposablesRef.current) disposable.dispose();
    runtimeHoverDisposablesRef.current = [];
    editorOpenerRef.current = monacoEditor.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const nextFile = editorFileForUri(resource);
        if (!nextFile) return false;

        setActiveFile(nextFile);
        pendingRevealRef.current = selectionOrPosition;
        window.requestAnimationFrame(() => {
          const currentEditor = editorRef.current;
          const currentFile = currentEditor?.getModel() ? editorFileForUri(currentEditor.getModel()!.uri) : undefined;
          if (currentEditor && currentFile === nextFile && pendingRevealRef.current) {
            revealEditorLocation(currentEditor, pendingRevealRef.current);
            pendingRevealRef.current = undefined;
          }
        });
        return true;
      },
    });

    runtimeHoverDisposablesRef.current = [
      new RuntimeValueWidget(monacoEditor, editorInstance, inspectionStore, autopilotModelUri),
    ];
  };

  useEffect(() => {
    ensureToolboxModel(monacoEditor, toolboxSource);
  }, [toolboxSource]);

  useEffect(() => {
    const model = monacoEditor.editor.getModel(monacoEditor.Uri.parse(autopilotModelUri));
    if (!model) return;
    const length = model.getValueLength();
    monacoEditor.editor.setModelMarkers(
      model,
      'playground-lint',
      compileWarnings
        .filter((warning) => warning.start + warning.length <= length)
        .map((warning) => {
          const start = model.getPositionAt(warning.start);
          const end = model.getPositionAt(warning.start + warning.length);
          return {
            severity: monacoEditor.MarkerSeverity.Warning,
            message: warning.message,
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          };
        }),
    );
  }, [compileWarnings]);

  const insertAtCursor = useCallback((code: string, setup: string[] = []) => {
    const currentEditor = editorRef.current;
    const model = currentEditor?.getModel();
    if (!currentEditor || !model || editorFileForUri(model.uri) !== 'autopilot') return;
    const selection = hasPlacedCursorRef.current ? currentEditor.getSelection() : null;
    const edits = [insertionEdit(model, selection, code)];
    const missingSetup = setup.filter((block) => !declaresSameName(model.getValue(), block));
    if (missingSetup.length > 0) {
      const setupText = `${missingSetup.join('\n\n')}\n\n`;
      const autopilotLine = model.findMatches('^export\\s+function\\s+autopilot\\b', false, true, true, null, false)[0]
        ?.range.startLineNumber ?? 1;
      if (selection && selection.startLineNumber <= autopilotLine) {
        // The cursor is already above autopilot, so the setup can go right where the code goes.
        edits[0] = { ...edits[0], text: `${setupText}${edits[0].text}` };
      } else {
        edits.push({ range: new monacoEditor.Range(autopilotLine, 1, autopilotLine, 1), text: setupText, forceMoveMarkers: true });
      }
    }
    currentEditor.executeEdits(
      'toolbox',
      edits,
      (inverseEdits) => {
        const end = inverseEdits[0].range.getEndPosition();
        return [new monacoEditor.Selection(end.lineNumber, end.column, end.lineNumber, end.column)];
      },
    );
    currentEditor.pushUndoStop();
    currentEditor.revealPositionInCenterIfOutsideViewport(currentEditor.getPosition()!);
    currentEditor.focus();
  }, []);

  useEffect(() => {
    if (!pendingRevealRef.current) return undefined;

    const animationFrame = window.requestAnimationFrame(() => {
      const currentEditor = editorRef.current;
      const currentFile = currentEditor?.getModel() ? editorFileForUri(currentEditor.getModel()!.uri) : undefined;
      if (currentEditor && currentFile === activeFile && pendingRevealRef.current) {
        revealEditorLocation(currentEditor, pendingRevealRef.current);
        pendingRevealRef.current = undefined;
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeFile]);

  useEffect(() => {
    return () => {
      editorOpenerRef.current?.dispose();
      editorOpenerRef.current = null;
      for (const disposable of runtimeHoverDisposablesRef.current) disposable.dispose();
      runtimeHoverDisposablesRef.current = [];
    };
  }, []);

  return (
    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 border-b border-border pr-3">
        <div className="flex self-stretch" role="tablist" aria-label="Editor files">
          <EditorTab active={activeFile === 'autopilot'} onSelect={() => setActiveFile('autopilot')} label="Autopilot.ts" />
          <EditorTab active={activeFile === 'api'} onSelect={() => setActiveFile('api')} label="API.d.ts" readOnly />
          <EditorTab active={activeFile === 'toolbox'} onSelect={() => setActiveFile('toolbox')} label="Toolbox.ts" readOnly />
        </div>
        <div className="flex items-center gap-2">
          {isReadOnly ? (
            <span className="inline-flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
              <LockKeyhole size={12} aria-hidden="true" />
              Read-only
            </span>
          ) : (
            <>
              {renderToolbox(insertAtCursor)}
              {examples.length === 1 ? (
                <button
                  type="button"
                  onClick={() => onLoadExample(examples[0].id)}
                  title={`Replace your code with "${examples[0].title}"`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  Start over
                </button>
              ) : (
                <label className="flex h-7 items-center gap-2 rounded-md border border-input px-2 text-xs text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
                  <span className="sr-only">Load example controller</span>
                  <select
                    value={selectedExampleId}
                    onChange={(event) => onLoadExample(event.target.value)}
                    className="max-w-56 bg-transparent text-foreground outline-none focus-visible:outline-none"
                  >
                    {!hasSelectedExample ? (
                      <option value={selectedExampleId} className="bg-popover text-popover-foreground">
                        Custom saved code
                      </option>
                    ) : null}
                    {examples.map((example) => (
                      <option key={example.id} value={example.id} className="bg-popover text-popover-foreground">
                        {example.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-[420px] flex-1 overflow-hidden">
        <Editor
          height="100%"
          language="typescript"
          theme="autopilot-dark"
          path={isToolboxActive ? toolboxModelUri : isApiActive ? autopilotApiDtsUri : autopilotModelUri}
          defaultValue={isToolboxActive ? toolboxSource : isApiActive ? publicAutopilotDts : undefined}
          value={isReadOnly ? undefined : code}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(value) => {
            const activeModel = editorRef.current?.getModel();
            if (activeModel && editorFileForUri(activeModel.uri) === 'autopilot') {
              onCodeChange(value ?? '');
            }
          }}
          keepCurrentModel
          options={{
            readOnly: isReadOnly,
            minimap: { enabled: false },
            fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            fontLigatures: false,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            padding: { top: 14, bottom: 14 },
            smoothScrolling: true,
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            hover: { delay: 150 },
          }}
        />
      </div>

      <div className="flex h-7 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground">
        {isToolboxActive ? (
          'Helper functions you can call from Autopilot.ts'
        ) : isApiActive ? (
          'Types for the input your controller receives and the output it returns'
        ) : (
          <>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${compileErrors.length > 0 ? 'bg-destructive' : codeStatus === 'Code loaded' ? 'bg-signal' : 'bg-muted-foreground'}`}
            />
            {compileErrors.length > 0 ? (
              <span className="text-destructive">{compileErrors.length} compile issue{compileErrors.length === 1 ? '' : 's'}</span>
            ) : (
              codeStatus
            )}
            {compileWarnings.length > 0 ? (
              <span className="text-warning">
                {compileWarnings.length} warning{compileWarnings.length === 1 ? '' : 's'}: hover the yellow underline
              </span>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** True when `source` already declares the variable that `block` declares. */
function declaresSameName(source: string, block: string): boolean {
  const name = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(block)?.[1];
  return name !== undefined && new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(source);
}

/**
 * Builds the edit that puts a toolbox snippet at the cursor, replacing any
 * selection. The snippet gets its own lines, indented like the cursor's line.
 * Without a cursor it goes at the end of the file.
 */
function insertionEdit(
  model: editor.ITextModel,
  selection: monacoEditor.Selection | null,
  code: string,
): editor.IIdentifiedSingleEditOperation {
  if (!selection) {
    const lastLine = model.getLineCount();
    const end = model.getLineMaxColumn(lastLine);
    const separator = model.getValue().trim() ? '\n\n' : '';
    return {
      range: new monacoEditor.Range(lastLine, end, lastLine, end),
      text: `${separator}${code}\n`,
      forceMoveMarkers: true,
    };
  }

  const line = model.getLineContent(selection.startLineNumber);
  const indent = /^\s*/.exec(line)![0];
  const before = line.slice(0, selection.startColumn - 1);
  const after = model.getLineContent(selection.endLineNumber).slice(selection.endColumn - 1);
  const startsOwnLine = !before.trim();
  const body = code
    .split('\n')
    .map((codeLine, index) => (codeLine === '' || (index === 0 && !startsOwnLine) ? codeLine : indent + codeLine))
    .join('\n');
  return {
    // On a blank or indent-only stretch, replace the leading whitespace so the indent isn't doubled.
    range: startsOwnLine
      ? new monacoEditor.Range(selection.startLineNumber, 1, selection.endLineNumber, selection.endColumn)
      : selection,
    text: `${startsOwnLine ? '' : `\n${indent}`}${body}${after.trim() ? `\n${/^\s/.test(after) ? '' : indent}` : ''}`,
    forceMoveMarkers: true,
  };
}

function EditorTab({ active, onSelect, label, readOnly = false }: { active: boolean; onSelect: () => void; label: string; readOnly?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`relative inline-flex items-center gap-1.5 border-r border-border px-4 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
        active
          ? 'bg-card text-foreground after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-signal'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {readOnly ? <LockKeyhole size={11} aria-hidden="true" className="opacity-60" /> : null}
    </button>
  );
}
