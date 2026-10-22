import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ValidationReport } from '../src/multiplayer/protocol';
import { runValidation } from '../src/multiplayer/validation';
import { driverWorkerModule } from '../src/sandbox/runnerSource';
import type { AutopilotInput } from '../src/types';
import type { Env } from './room';

/** Per-step wall-clock budget. Generous next to the race's 28 ms because it includes RPC overhead. */
const STEP_TIMEOUT_MS = 250;
/** CPU cap for the driver's isolate; a typical driver needs well under 1 s for the whole test drive. */
const DRIVER_CPU_MS = 5000;
/** Wall-clock cap for one whole validation, including compiling and loading the driver. */
const VALIDATION_DEADLINE_MS = 45_000;
/**
 * The room object can share this isolate, and awaiting the driver alone does not let its messages
 * through. Yielding to the event loop every few steps (about 20 ms of simulation) keeps the room live.
 */
const YIELD_EVERY_STEPS = 8;

interface DriverSession {
  step(input: AutopilotInput): Promise<unknown>;
}

/**
 * Test-drives a submission before it may race. The trusted simulation runs here; the player's code
 * runs in its own Dynamic Worker isolate with no network access, called once per simulation step.
 */
export class Validator extends WorkerEntrypoint<Env> {
  async validate(source: string, seed: number): Promise<ValidationReport> {
    const deadline = Date.now() + VALIDATION_DEADLINE_MS;
    // TypeScript treats any runtime with `process` as Node and reaches for the file system. Mark this
    // one as a browser so it runs exactly as it does in the editor.
    if (typeof process !== 'undefined') (process as { browser?: boolean }).browser = true;
    // Loaded on first use so requests that never validate don't pay to start TypeScript.
    const { compileUserCode } = await import('../src/sandbox/compiler');
    const compiled = compileUserCode(source);
    if (!compiled.ok) {
      return {
        passed: false,
        issues: [{ check: 'compile', message: `The code did not compile:\n${compiled.errors.slice(0, 5).join('\n')}` }],
      };
    }

    const worker = this.env.LOADER.get(`driver-${crypto.randomUUID()}`, () => ({
      compatibilityDate: '2026-07-03',
      mainModule: 'driver.js',
      modules: { 'driver.js': driverWorkerModule(compiled.js) },
      globalOutbound: null,
      limits: { cpuMs: DRIVER_CPU_MS },
    }));
    let session: DriverSession;
    try {
      session = (await (worker.getEntrypoint() as unknown as { start(): Promise<DriverSession> }).start()) as DriverSession;
    } catch (error) {
      return { passed: false, issues: [{ check: 'errors', message: `Your driver failed to load: ${errorMessage(error)}` }] };
    }

    let steps = 0;
    return runValidation(
      async (input) => {
        if (++steps % YIELD_EVERY_STEPS === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        return withTimeout(session.step(input), STEP_TIMEOUT_MS);
      },
      { seed, deadline },
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`A step took longer than ${ms} ms.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
