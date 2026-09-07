import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Braces, Code2, FileCode2, LockKeyhole, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { editor } from 'monaco-editor/esm/vs/editor/editor.api';
import * as monacoEditor from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { RuntimeInspectionStore } from '../sandbox';
import { toolboxLibrarySource, type ControllerExample } from '../toolbox';
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
    '| `ego` | Current ego speed, heading, and lane index. |',
    '| `vehicles` | Stable filtered tracks, including velocity and uncertainty. |',
    '| `vehicleMeasurements` | Raw noisy observations before tracking; these may drop out. |',
    '| `laneLines` | Left/right/far lane-line sample points relative to ego. |',
    '| `targetLane` | Lane the controller should track. For the MVP this usually matches the current lane. |',
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
    '| `targetLane` | Optional requested lane index. Exposed now for future lane-change work. |',
    '| `debug` | Optional PID telemetry for the UI. It never affects physics. |',
    '',
    'The simulator clamps invalid motor and steering values defensively.',
  ].join('\n'),
  EgoState: [
    '**EgoState**',
    '',
    'Basic state of the controlled car.',
    '',
    '`speed` is meters per second. `heading` is radians relative to the road/world frame. `laneIndex` is `0`, `1`, or `2` on the current 3-lane road.',
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
  ].join('\n'),
  VehicleDetection: [
    '**VehicleDetection**',
    '',
    'Deprecated compatibility name for `VehicleTrack`. New code should use `VehicleTrack`.',
    '',
    'Use `laneIndex` and `relativeY` to find lead vehicles for adaptive cruise control.',
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
    'Interpreted lane geometry returned by `analyzeLaneRegression(...)`.',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `centerOffset` | Lateral offset from target lane center in meters. |',
    '| `heading` | Lane heading error in radians, at ego in local mode or ahead in preview mode. |',
    '| `curvature` | Signed lane curvature at ego in local mode, or ahead in preview mode. |',
    '| `confidence` | Aggregate quality of the lane samples used for the fit. |',
  ].join('\n'),
  analyzeLaneRegression: [
    '**analyzeLaneRegression(laneLines, relativeTargetLane?, mode?)**',
    '',
    'Built-in helper available inside user code.',
    '',
    'By default it fits the nearest 3–21 meters and estimates geometry at ego for steering. Pass `"preview"` as the third argument for the original longer 5–56 meter fit for speed planning.',
    '',
    'Use it when sharp turns or noisy lane-line samples make a simple three-point lane estimate too jumpy.',
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
    'Creates a stateful PID controller with output limits, optional integral limits, reset, and debug terms.',
  ].join('\n'),
  analyzeLane: [
    '**analyzeLane(laneLines)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Interprets detected lane lines into center offset, heading, curvature, and confidence.',
  ].join('\n'),
  accelerationFeedforward: [
    '**accelerationFeedforward(targetSpeed, currentSpeed)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Estimates a motor command from speed error plus simple drag compensation.',
  ].join('\n'),
  adaptiveCruiseTargetSpeed: [
    '**adaptiveCruiseTargetSpeed(input, freeRoadSpeed)**',
    '',
    'Toolbox helper from `autopilot-toolbox.ts`.',
    '',
    'Reduces target speed when the closest vehicle ahead is inside the desired following gap.',
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

function ensureToolboxModel(monaco: MonacoApi): void {
  const uri = monaco.Uri.parse(toolboxModelUri);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== toolboxLibrarySource) existing.setValue(toolboxLibrarySource);
    return;
  }

  monaco.editor.createModel(toolboxLibrarySource, 'typescript', uri);
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
  codeStatus: string;
  inspectionStore: RuntimeInspectionStore;
  toolbox: ReactNode;
  onCodeChange: (code: string) => void;
  onLoadExample: (id: string) => void;
}

export function EditorPanel({
  code,
  examples,
  selectedExampleId,
  compileErrors,
  codeStatus,
  inspectionStore,
  toolbox,
  onCodeChange,
  onLoadExample,
}: EditorPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const editorOpenerRef = useRef<monacoEditor.IDisposable | null>(null);
  const runtimeHoverDisposablesRef = useRef<monacoEditor.IDisposable[]>([]);
  const pendingRevealRef = useRef<EditorLocation>();
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
    ensureToolboxModel(monaco);
    registerAutopilotHoverProvider(monaco);
    monaco.editor.defineTheme('autopilot-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '71717a' },
        { token: 'keyword', foreground: '93c5fd' },
        { token: 'number', foreground: 'fde68a' },
        { token: 'string', foreground: '86efac' },
      ],
      colors: {
        'editor.background': '#09090b',
        'editor.foreground': '#fafafa',
        'editorLineNumber.foreground': '#71717a',
        'editorLineNumber.activeForeground': '#fafafa',
        'editor.selectionBackground': '#27272a',
        'editorCursor.foreground': '#fafafa',
      },
    });
  };

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/50 p-1" role="tablist" aria-label="Editor files">
          <button
            type="button"
            onClick={() => setActiveFile('autopilot')}
            className={`inline-flex h-8 items-center gap-2 rounded px-2.5 text-xs font-semibold uppercase tracking-[0.18em] transition ${
              activeFile === 'autopilot'
                ? 'bg-blue-500/10 text-blue-100 shadow-sm ring-1 ring-blue-500/20'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            role="tab"
            aria-selected={activeFile === 'autopilot'}
          >
            <Code2 size={14} />
            Autopilot.ts
          </button>
          <button
            type="button"
            onClick={() => setActiveFile('api')}
            className={`inline-flex h-8 items-center gap-2 rounded px-2.5 text-xs font-semibold uppercase tracking-[0.18em] transition ${
              activeFile === 'api'
                ? 'bg-emerald-500/10 text-emerald-100 shadow-sm ring-1 ring-emerald-500/20'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            role="tab"
            aria-selected={activeFile === 'api'}
          >
            <Braces size={14} />
            API.d.ts
          </button>
          <button
            type="button"
            onClick={() => setActiveFile('toolbox')}
            className={`inline-flex h-8 items-center gap-2 rounded px-2.5 text-xs font-semibold uppercase tracking-[0.18em] transition ${
              activeFile === 'toolbox'
                ? 'bg-amber-500/10 text-amber-100 shadow-sm ring-1 ring-amber-500/20'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
            role="tab"
            aria-selected={activeFile === 'toolbox'}
          >
            <Wrench size={14} />
            Toolbox.ts
          </button>
        </div>
        <div className="flex items-center gap-2">
          {isReadOnly ? (
            <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-muted/50 px-3 text-xs font-semibold text-muted-foreground">
              <LockKeyhole size={13} aria-hidden="true" />
              Read-only
            </span>
          ) : (
            <>
              {toolbox}
              <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-muted-foreground shadow-sm">
                <FileCode2 size={14} />
                <select
                  value={selectedExampleId}
                  onChange={(event) => onLoadExample(event.target.value)}
                  className="max-w-56 bg-transparent text-foreground outline-none"
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
          defaultValue={isToolboxActive ? toolboxLibrarySource : isApiActive ? publicAutopilotDts : undefined}
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

      <div className="border-t border-border px-4 py-2 text-xs">
        {isToolboxActive ? (
          <span className="text-amber-200">autopilot-toolbox.ts</span>
        ) : isApiActive ? (
          <span className="text-emerald-200">autopilot-api.d.ts · public controller interfaces</span>
        ) : compileErrors.length > 0 ? (
          <span className="text-red-400">{compileErrors.length} compile issue{compileErrors.length === 1 ? '' : 's'}</span>
        ) : (
          <span className="text-emerald-400">{codeStatus}</span>
        )}
      </div>
    </section>
  );
}
