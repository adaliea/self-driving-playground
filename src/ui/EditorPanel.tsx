import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Code2, FileCode2 } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { editor } from 'monaco-editor';
import * as monacoEditor from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { ControllerExample } from '../toolbox';
import { publicAutopilotDts } from '../types/publicDts';

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
    '| `vehicles` | Nearby vehicle detections in ego-relative coordinates. |',
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
  VehicleDetection: [
    '**VehicleDetection**',
    '',
    'A nearby vehicle observed by the sensor model.',
    '',
    '`relativeX` is lateral meters from ego: negative is left, positive is right. `relativeY` is longitudinal meters: positive is ahead, negative is behind.',
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
    '| `heading` | Estimated lane heading ahead of ego, in radians. |',
    '| `curvature` | Signed lane curvature estimate ahead of ego. |',
    '| `confidence` | Aggregate quality of the lane samples used for the fit. |',
  ].join('\n'),
  analyzeLaneRegression: [
    '**analyzeLaneRegression(laneLines, relativeTargetLane?)**',
    '',
    'Built-in helper available inside user code.',
    '',
    'It fits a weighted quadratic regression through forward lane-center samples and returns `LaneAnalysis`.',
    '',
    'Use it when sharp turns or noisy lane-line samples make a simple three-point lane estimate too jumpy.',
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
    'Set `lanePid` or `speedPid` to show PID term visualizations in telemetry.',
  ].join('\n'),
};

let autopilotHoverProviderRegistered = false;

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

interface EditorPanelProps {
  code: string;
  examples: ControllerExample[];
  selectedExampleId: string;
  compileErrors: string[];
  codeStatus: string;
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
  toolbox,
  onCodeChange,
  onLoadExample,
}: EditorPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      allowNonTsExtensions: true,
      strict: true,
      noEmit: true,
      isolatedModules: true,
    });
    monaco.languages.typescript.typescriptDefaults.addExtraLib(publicAutopilotDts, 'ts:autopilot-api.d.ts');
    registerAutopilotHoverProvider(monaco);
    monaco.editor.defineTheme('autopilot-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '72838a' },
        { token: 'keyword', foreground: '89a9ff' },
        { token: 'number', foreground: 'f7c86d' },
        { token: 'string', foreground: '82dec1' },
      ],
      colors: {
        'editor.background': '#071013',
        'editor.foreground': '#d7e5e4',
        'editorLineNumber.foreground': '#395057',
        'editorLineNumber.activeForeground': '#6df7d1',
        'editor.selectionBackground': '#26484d',
        'editorCursor.foreground': '#6df7d1',
      },
    });
  };

  const onMount: OnMount = (editorInstance) => {
    editorRef.current = editorInstance;
  };

  return (
    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Code2 className="text-mint" size={18} />
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-100">Autopilot.ts</h2>
        </div>
        <div className="flex items-center gap-2">
          {toolbox}
          <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-400">
            <FileCode2 size={14} />
            <select
              value={selectedExampleId}
              onChange={(event) => onLoadExample(event.target.value)}
              className="max-w-56 bg-transparent text-slate-100 outline-none"
            >
              {examples.map((example) => (
                <option key={example.id} value={example.id} className="bg-panel text-slate-100">
                  {example.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="min-h-[420px] flex-1 overflow-hidden">
        <Editor
          height="100%"
          language="typescript"
          theme="autopilot-dark"
          value={code}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(value) => onCodeChange(value ?? '')}
          options={{
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

      <div className="border-t border-white/10 px-4 py-2 text-xs">
        {compileErrors.length > 0 ? (
          <span className="text-red-200">{compileErrors.length} compile issue{compileErrors.length === 1 ? '' : 's'}</span>
        ) : (
          <span className="text-mint">{codeStatus}</span>
        )}
      </div>
    </section>
  );
}
