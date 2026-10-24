import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RenderTelemetry } from './rendering';
import { CanvasRenderer } from './rendering';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP, Simulation } from './simulation';
import { CompilerClient, describeCompilerStatus, RuntimeInspectionStore, SandboxClient, type CompileWarning, type CompilerStatus, type GraphValues } from './sandbox';
import { controllerExamples, defaultControllerExample, toolboxSnippets, visibleToolboxSource, type ControllerExample } from './toolbox';
import type { PlaygroundSettings } from './types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/AlertDialog';
import { ControlPanel } from './ui/ControlPanel';
import { SimulatorCanvas } from './ui/SimulatorCanvas';
import { TelemetryPanel } from './ui/TelemetryPanel';
import { ToolboxPanel } from './ui/ToolboxPanel';

const EditorPanel = lazy(() => import('./ui/EditorPanel').then((module) => ({ default: module.EditorPanel })));

const userCodeStorageKey = (namespace: string) => `self-driving-playground:${namespace}user-code:v1`;
const settingsStorageKey = (namespace: string) => `self-driving-playground:${namespace}settings:v1`;
const USER_CODE_SAVE_DEBOUNCE_MS = 500;
const SETTINGS_SAVE_DEBOUNCE_MS = 500;
const CUSTOM_CONTROLLER_ID = 'custom';

interface InitialController {
  code: string;
  selectedExampleId: string;
}

export interface AppTopBarContext {
  code: string;
  /** True when the current editor code compiled and loaded into the local runner. */
  codeReady: boolean;
  /** True while steer or accelerate assist is overriding the code locally. */
  assistsOn: boolean;
  applySettings: (settings: Partial<PlaygroundSettings>) => void;
}

interface AppProps {
  /** Optional bar above the editor and simulator, used by multiplayer rooms. */
  renderTopBar?: (context: AppTopBarContext) => ReactNode;
  /**
   * Examples to offer. The first is the starting code and settings for a new
   * browser. With a single example, the editor offers "Start over" instead of a list.
   */
  examples?: ControllerExample[];
  /** Prefix for saved code and settings, so different modes don't overwrite each other. */
  storageNamespace?: string;
  /** Toolbox snippet ids the presenter has locked. */
  lockedHelpers?: readonly string[];
  /** Fill the parent element instead of the window, e.g. inside a presentation slide. */
  embedded?: boolean;
  /** Editor font size in pixels. Default: 13. */
  editorFontSize?: number;
  /** False while hidden: skips drawing and telemetry updates. A running simulation keeps going. */
  active?: boolean;
}

const NO_LOCKED_HELPERS: readonly string[] = [];

function App({
  renderTopBar,
  examples = controllerExamples,
  storageNamespace = '',
  lockedHelpers = NO_LOCKED_HELPERS,
  embedded = false,
  editorFontSize,
  active = true,
}: AppProps = {}) {
  const [baseSettings] = useState<PlaygroundSettings>(() => ({ ...DEFAULT_SETTINGS, ...examples[0]?.recommendedSettings }));
  const [initialController] = useState(() => loadInitialController(examples, storageNamespace));
  const [settings, setSettings] = useState<PlaygroundSettings>(() => loadStoredSettings(storageNamespace, baseSettings));
  const [running, setRunning] = useState(false);
  const [code, setCode] = useState(initialController.code);
  const [selectedExampleId, setSelectedExampleId] = useState(initialController.selectedExampleId);
  const [pendingExampleId, setPendingExampleId] = useState<string>();
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileWarnings, setCompileWarnings] = useState<CompileWarning[]>([]);
  const [runtimeError, setRuntimeError] = useState<string>();
  const [codeStatus, setCodeStatus] = useState('Starting code runner');
  const [compilerStatus, setCompilerStatus] = useState<CompilerStatus>({ stage: 'idle' });

  const simulationRef = useRef<Simulation>();
  if (!simulationRef.current) simulationRef.current = new Simulation(settings);

  const [telemetry, setTelemetry] = useState<RenderTelemetry>(() =>
    simulationRef.current!.getSnapshot(settings).telemetry,
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer>();
  const sandboxRef = useRef<SandboxClient>();
  const compilerRef = useRef<CompilerClient>();
  const inspectionStoreRef = useRef<RuntimeInspectionStore>();
  const settingsRef = useRef(settings);
  const runningRef = useRef(running);
  const codeRef = useRef(code);
  const codeLoadedRef = useRef(false);
  const compileSequenceRef = useRef(0);
  const runtimeErrorRef = useRef<string | undefined>(undefined);
  const graphsRef = useRef<GraphValues>();
  const activeRef = useRef(active);
  activeRef.current = active;
  const firstCompileDoneRef = useRef(false);

  if (!compilerRef.current) compilerRef.current = new CompilerClient();
  if (!inspectionStoreRef.current) inspectionStoreRef.current = new RuntimeInspectionStore();

  // While the compiler is still downloading or booting, its progress is more useful than the runner status.
  const compilerLoading = compilerStatus.stage === 'downloading' || compilerStatus.stage === 'starting';
  const displayedCodeStatus = compilerLoading
    ? (describeCompilerStatus(compilerStatus) ?? codeStatus)
    : codeStatus === 'Compiling TypeScript' && compilerStatus.stage === 'ready' && !firstCompileDoneRef.current
      ? 'Step 3/3 · Compiling TypeScript'
      : codeStatus;

  useEffect(() => {
    settingsRef.current = settings;
    const timer = window.setTimeout(() => saveSettings(storageNamespace, settings), SETTINGS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    runningRef.current = running;
    inspectionStoreRef.current!.setRunning(running);
  }, [running]);

  useEffect(() => {
    codeRef.current = code;
    const timer = window.setTimeout(() => saveUserCode(storageNamespace, code), USER_CODE_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [code]);

  useEffect(() => {
    const flushStoredState = () => {
      saveUserCode(storageNamespace, codeRef.current);
      saveSettings(storageNamespace, settingsRef.current);
    };
    window.addEventListener('pagehide', flushStoredState);
    window.addEventListener('beforeunload', flushStoredState);

    return () => {
      window.removeEventListener('pagehide', flushStoredState);
      window.removeEventListener('beforeunload', flushStoredState);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sandbox = new SandboxClient('/sandbox.html');
    sandboxRef.current = sandbox;
    sandbox
      .start()
      .then(() => {
        if (!cancelled) setCodeStatus((status) => (status === 'Starting code runner' ? 'Code runner ready' : status));
      })
      .catch((error) => {
        if (!cancelled) setCodeStatus(`Code runner unavailable: ${formatError(error)}`);
      });

    return () => {
      cancelled = true;
      sandbox.dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sequence = ++compileSequenceRef.current;
    codeLoadedRef.current = false;
    graphsRef.current = undefined;
    inspectionStoreRef.current!.clearProgram();
    setCodeStatus('Compiling TypeScript');

    const timer = window.setTimeout(async () => {
      let result;
      try {
        result = await compilerRef.current!.compile(code);
        firstCompileDoneRef.current = true;
      } catch (error) {
        if (cancelled || sequence !== compileSequenceRef.current) return;
        setCompileErrors([formatError(error)]);
        setCodeStatus('Compile failed');
        return;
      }

      if (cancelled || sequence !== compileSequenceRef.current) return;

      setCompileWarnings(result.warnings);
      if (!result.ok) {
        setCompileErrors(result.errors);
        setCodeStatus('Compile blocked');
        return;
      }

      setCompileErrors([]);
      try {
        const version = await sandboxRef.current?.loadCode(result.js);
        if (cancelled || sequence !== compileSequenceRef.current) return;
        if (version !== undefined) inspectionStoreRef.current!.setProgram(version, result.inspection);
        codeLoadedRef.current = true;
        setCodeStatus('Code loaded');
        setRuntimeError(undefined);
        runtimeErrorRef.current = undefined;
      } catch (error) {
        if (cancelled || sequence !== compileSequenceRef.current) return;
        codeLoadedRef.current = false;
        setCompileErrors([formatRunnerError(error)]);
        setCodeStatus('Code load failed');
      }
    }, 360);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code]);

  useEffect(() => {
    const compiler = compilerRef.current!;
    const unsubscribe = compiler.subscribe(setCompilerStatus);
    compiler.preload();
    return () => {
      unsubscribe();
      compiler.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    if (!canvasRef.current) return undefined;
    const renderer = new CanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;

    const renderNow = () => {
      renderer.resize();
      const snapshot = simulationRef.current!.getSnapshot(settingsRef.current);
      renderer.render(snapshot);
      setTelemetry(snapshot.telemetry);
    };

    renderNow();
    const target = canvasRef.current.parentElement ?? canvasRef.current;
    const observer = new ResizeObserver(renderNow);
    observer.observe(target);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let animationFrame = 0;
    let disposed = false;
    let previous = performance.now();
    let accumulator = 0;
    let lastTelemetryUpdate = 0;

    const frame = async (now: number) => {
      if (disposed) return;
      const elapsed = Math.min(0.08, Math.max(0, (now - previous) / 1000));
      previous = now;
      const settingsSnapshot = settingsRef.current;
      const simulation = simulationRef.current!;

      if (runningRef.current) {
        accumulator += elapsed;
        let steps = 0;

        while (accumulator >= FIXED_TIMESTEP && steps < 3 && !disposed) {
          const input = simulation.createEgoInput(settingsSnapshot, FIXED_TIMESTEP);
          let output: unknown = { motor: 0, steering: 0 };

          if (codeLoadedRef.current && sandboxRef.current) {
            try {
              const runResult = await sandboxRef.current.run(input, 28);
              output = runResult.output;
              graphsRef.current = runResult.graphs;
              if (runResult.inspection) inspectionStoreRef.current!.updateSnapshot(runResult.inspection);
              if (runtimeErrorRef.current) {
                runtimeErrorRef.current = undefined;
                setRuntimeError(undefined);
              }
            } catch (error) {
              const message = formatRunnerError(error);
              output = { motor: 0, steering: 0 };
              graphsRef.current = undefined;
              if (runtimeErrorRef.current !== message) {
                runtimeErrorRef.current = message;
                setRuntimeError(message);
              }
            }
          }

          simulation.step(FIXED_TIMESTEP, output, settingsSnapshot);
          accumulator -= FIXED_TIMESTEP;
          steps += 1;
        }

        if (steps >= 3) accumulator = 0;
      } else {
        accumulator = 0;
      }

      if (!activeRef.current) {
        animationFrame = requestAnimationFrame(frame);
        return;
      }
      const snapshot = simulation.getSnapshot(settingsSnapshot);
      rendererRef.current?.render(snapshot);
      if (now - lastTelemetryUpdate > 110) {
        setTelemetry({ ...snapshot.telemetry, graphs: graphsRef.current });
        lastTelemetryUpdate = now;
      }

      animationFrame = requestAnimationFrame(frame);
    };

    animationFrame = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
    };
  }, []);

  const resetSimulation = useCallback(() => {
    simulationRef.current!.reset(settingsRef.current);
    const snapshot = simulationRef.current!.getSnapshot(settingsRef.current);
    rendererRef.current?.render(snapshot);
    setTelemetry(snapshot.telemetry);
    setRuntimeError(undefined);
    runtimeErrorRef.current = undefined;
  }, []);

  const updateSettings = useCallback((nextSettings: PlaygroundSettings) => {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
  }, []);

  const resetSettingsToDefaults = useCallback(() => {
    const defaults = { ...baseSettings };
    updateSettings(defaults);
    simulationRef.current!.reset(defaults);
    const snapshot = simulationRef.current!.getSnapshot(defaults);
    rendererRef.current?.render(snapshot);
    setTelemetry(snapshot.telemetry);
  }, [baseSettings, updateSettings]);

  const updateCode = useCallback((nextCode: string) => {
    codeRef.current = nextCode;
    setCode(nextCode);
    setSelectedExampleId(findControllerExampleIdForCode(examples, nextCode) ?? CUSTOM_CONTROLLER_ID);
  }, [examples]);

  const applyExample = useCallback(
    (example: ControllerExample) => {
      setSelectedExampleId(example.id);
      updateCode(example.code);
      if (example.recommendedSettings) {
        updateSettings({ ...settingsRef.current, ...example.recommendedSettings });
      }
    },
    [updateCode, updateSettings],
  );

  const loadExample = useCallback((id: string) => {
    const example = examples.find((candidate) => candidate.id === id);
    if (!example) return;
    if (wouldOverwriteEditedCode(examples, codeRef.current, selectedExampleId, example.code)) {
      setPendingExampleId(example.id);
      return;
    }

    applyExample(example);
  }, [applyExample, examples, selectedExampleId]);

  const pendingExample = examples.find((example) => example.id === pendingExampleId);
  const toolboxSource = useMemo(() => visibleToolboxSource(lockedHelpers), [lockedHelpers]);
  const unlockedSnippets = useMemo(
    () => toolboxSnippets.filter((snippet) => !lockedHelpers.includes(snippet.id)),
    [lockedHelpers],
  );

  return (
    <div className={`flex flex-col bg-background text-foreground ${embedded ? 'h-full min-h-0' : 'min-h-screen lg:h-screen'}`}>
      {renderTopBar?.({
        code,
        codeReady: codeStatus === 'Code loaded' && compileErrors.length === 0,
        assistsOn: settings.steerAssist || settings.accelerateAssist,
        applySettings: (patch) => {
          const next = { ...settingsRef.current, ...patch };
          updateSettings(next);
          resetSimulation();
        },
      })}
      <main className="grid min-h-0 min-w-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="grid min-h-[620px] min-w-0 border-r border-border lg:h-full lg:min-h-0">
          <Suspense
            fallback={
              <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden bg-background">
                <div className="h-12 border-b border-border" />
                <div className="flex min-h-[420px] flex-1 items-center justify-center text-sm text-muted-foreground">
                  Loading editor
                </div>
              </section>
            }
          >
            <EditorPanel
              code={code}
              examples={examples}
              selectedExampleId={selectedExampleId}
              compileErrors={compileErrors}
              compileWarnings={compileWarnings}
              toolboxSource={toolboxSource}
              fontSize={editorFontSize}
              codeStatus={displayedCodeStatus}
              inspectionStore={inspectionStoreRef.current}
              renderToolbox={(insertAtCursor) => <ToolboxPanel snippets={unlockedSnippets} source={code} onInsert={insertAtCursor} />}
              onCodeChange={updateCode}
              onLoadExample={loadExample}
            />
          </Suspense>
        </div>

        <div className="flex min-h-[620px] min-w-0 flex-col lg:h-full lg:min-h-0">
          <ControlPanel
            running={running}
            settings={settings}
            onRunningChange={setRunning}
            onReset={resetSimulation}
            onResetSettings={resetSettingsToDefaults}
            onSettingsChange={updateSettings}
          />
          <SimulatorCanvas ref={canvasRef} />
          <TelemetryPanel
            inspectionStore={inspectionStoreRef.current}
            telemetry={telemetry}
            compileErrors={compileErrors}
            compileWarnings={compileWarnings}
            runtimeError={runtimeError}
          />
        </div>
      </main>

      <AlertDialog open={Boolean(pendingExample)} onOpenChange={(open) => !open && setPendingExampleId(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Autopilot.ts?</AlertDialogTitle>
            <AlertDialogDescription>
              Loading {pendingExample ? `"${pendingExample.title}"` : 'this example'} will replace your current controller code.
              Your current code is saved in this browser until you continue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current code</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingExample) applyExample(pendingExample);
                setPendingExampleId(undefined);
              }}
            >
              Replace code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatRunnerError(error: unknown): string {
  return formatError(error).replace(/sandbox/gi, 'code runner').replace(/worker/gi, 'code runner');
}

function loadInitialController(examples: ControllerExample[], namespace: string): InitialController {
  const code = loadStoredUserCode(namespace, (examples[0] ?? defaultControllerExample).code);
  return {
    code,
    selectedExampleId: findControllerExampleIdForCode(examples, code) ?? CUSTOM_CONTROLLER_ID,
  };
}

function loadStoredUserCode(namespace: string, fallback: string): string {
  try {
    return window.localStorage.getItem(userCodeStorageKey(namespace)) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadStoredSettings(namespace: string, defaults: PlaygroundSettings): PlaygroundSettings {
  try {
    const rawSettings = window.localStorage.getItem(settingsStorageKey(namespace));
    if (!rawSettings) return { ...defaults };

    const parsed = JSON.parse(rawSettings) as Record<string, unknown>;
    return {
      seed: finiteNumberOr(parsed.seed, defaults.seed),
      trafficDensity: boundedNumberOr(parsed.trafficDensity, defaults.trafficDensity, 0, 1),
      startingSpeed: boundedNumberOr(parsed.startingSpeed, defaults.startingSpeed, 8, 34),
      noisyLaneLines: booleanOr(parsed.noisyLaneLines, defaults.noisyLaneLines),
      noisyVehicles: booleanOr(parsed.noisyVehicles, defaults.noisyVehicles),
      actuatorVariation: booleanOr(parsed.actuatorVariation, defaults.actuatorVariation),
      wind: booleanOr(parsed.wind, defaults.wind),
      debugOverlays: booleanOr(parsed.debugOverlays, defaults.debugOverlays),
      steerAssist: booleanOr(parsed.steerAssist, defaults.steerAssist),
      accelerateAssist: booleanOr(parsed.accelerateAssist, defaults.accelerateAssist),
    };
  } catch {
    return { ...defaults };
  }
}

function saveUserCode(namespace: string, code: string): void {
  try {
    window.localStorage.setItem(userCodeStorageKey(namespace), code);
  } catch {
    // Ignore storage errors, such as private browsing restrictions or quota limits.
  }
}

function saveSettings(namespace: string, settings: PlaygroundSettings): void {
  try {
    window.localStorage.setItem(settingsStorageKey(namespace), JSON.stringify(settings));
  } catch {
    // Ignore storage errors, such as private browsing restrictions or quota limits.
  }
}

function findControllerExampleIdForCode(examples: ControllerExample[], code: string): string | undefined {
  return examples.find((example) => example.code === code)?.id;
}

function wouldOverwriteEditedCode(examples: ControllerExample[], currentCode: string, selectedId: string, nextCode: string): boolean {
  if (currentCode === nextCode) return false;
  const selectedExample = examples.find((example) => example.id === selectedId);
  return !selectedExample || currentCode !== selectedExample.code;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boundedNumberOr(value: unknown, fallback: number, min: number, max: number): number {
  const number = finiteNumberOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default App;
