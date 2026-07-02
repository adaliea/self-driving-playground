import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { RenderTelemetry } from './rendering';
import { CanvasRenderer } from './rendering';
import { DEFAULT_SETTINGS, FIXED_TIMESTEP, Simulation } from './simulation';
import { SandboxClient, compileUserCode } from './sandbox';
import { controllerExamples, defaultControllerExample, toolboxSnippets } from './toolbox';
import type { PlaygroundSettings } from './types';
import { ControlPanel, EditorPanel, SimulatorCanvas, TelemetryPanel, ToolboxPanel } from './ui';

function App() {
  const [settings, setSettings] = useState<PlaygroundSettings>(DEFAULT_SETTINGS);
  const [running, setRunning] = useState(false);
  const [code, setCode] = useState(defaultControllerExample.code);
  const [selectedExampleId, setSelectedExampleId] = useState(defaultControllerExample.id);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [runtimeError, setRuntimeError] = useState<string>();
  const [codeStatus, setCodeStatus] = useState('Starting code runner');

  const simulationRef = useRef<Simulation>();
  if (!simulationRef.current) simulationRef.current = new Simulation(DEFAULT_SETTINGS);

  const [telemetry, setTelemetry] = useState<RenderTelemetry>(() =>
    simulationRef.current!.getSnapshot(DEFAULT_SETTINGS).telemetry,
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer>();
  const sandboxRef = useRef<SandboxClient>();
  const settingsRef = useRef(settings);
  const runningRef = useRef(running);
  const codeLoadedRef = useRef(false);
  const compileSequenceRef = useRef(0);
  const runtimeErrorRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    let cancelled = false;
    const sandbox = new SandboxClient('/sandbox.html');
    sandboxRef.current = sandbox;
    sandbox
      .start()
      .then(() => {
        if (!cancelled) setCodeStatus('Code runner ready');
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
    setCodeStatus('Compiling TypeScript');

    const timer = window.setTimeout(async () => {
      const result = compileUserCode(code);
      if (cancelled || sequence !== compileSequenceRef.current) return;

      if (!result.ok) {
        setCompileErrors(result.errors);
        setCodeStatus('Compile blocked');
        return;
      }

      setCompileErrors([]);
      try {
        await sandboxRef.current?.loadCode(result.js);
        if (cancelled || sequence !== compileSequenceRef.current) return;
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
          let output: unknown = {
            motor: 0,
            steering: 0,
            targetLane: input.targetLane,
          };

          if (codeLoadedRef.current && sandboxRef.current) {
            try {
              output = await sandboxRef.current.run(input, 28);
              if (runtimeErrorRef.current) {
                runtimeErrorRef.current = undefined;
                setRuntimeError(undefined);
              }
            } catch (error) {
              const message = formatRunnerError(error);
              output = {
                motor: 0,
                steering: 0,
                targetLane: input.targetLane,
              };
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

      const snapshot = simulation.getSnapshot(settingsSnapshot);
      rendererRef.current?.render(snapshot);
      if (now - lastTelemetryUpdate > 110) {
        setTelemetry(snapshot.telemetry);
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

  const loadExample = useCallback((id: string) => {
    const example = controllerExamples.find((candidate) => candidate.id === id);
    if (!example) return;
    setSelectedExampleId(example.id);
    setCode(example.code);
    if (example.recommendedSettings) {
      setSettings((current) => ({ ...current, ...example.recommendedSettings }));
    }
  }, []);

  const insertSnippet = useCallback((snippet: string) => {
    setCode((current) => `${current.trimEnd()}\n\n${snippet}\n`);
  }, []);

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <header className="border-b border-white/10 bg-[#050b0d] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md border border-mint/30 bg-mint/10 text-mint shadow-glow">
              <Activity size={21} />
            </div>
            <div>
              <h1 className="text-base font-semibold uppercase tracking-[0.28em] text-slate-100">Self-Driving Playground</h1>
              <p className="mt-1 text-xs text-slate-500">PID loops, noisy perception, traffic, and imperfect actuation</p>
            </div>
          </div>
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-69px)] min-w-0 grid-cols-1 lg:grid-cols-2">
        <div className="grid min-h-[620px] min-w-0 border-r border-white/10 lg:h-[calc(100vh-69px)]">
          <EditorPanel
            code={code}
            examples={controllerExamples}
            selectedExampleId={selectedExampleId}
            compileErrors={compileErrors}
            codeStatus={codeStatus}
            toolbox={<ToolboxPanel snippets={toolboxSnippets} onInsert={insertSnippet} />}
            onCodeChange={setCode}
            onLoadExample={loadExample}
          />
        </div>

        <div className="flex min-h-[620px] min-w-0 flex-col lg:h-[calc(100vh-69px)]">
          <ControlPanel
            running={running}
            settings={settings}
            onRunningChange={setRunning}
            onReset={resetSimulation}
            onSettingsChange={setSettings}
          />
          <SimulatorCanvas ref={canvasRef} />
          <TelemetryPanel telemetry={telemetry} compileErrors={compileErrors} runtimeError={runtimeError} />
        </div>
      </main>
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

export default App;
