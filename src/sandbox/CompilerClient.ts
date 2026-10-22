import compilerWorkerUrl from './compiler.worker?worker&url';
import type { CompileResult } from './compiler';

const COMPILE_TIMEOUT_MS = 10000;

export type CompilerLoadStage = 'idle' | 'downloading' | 'starting' | 'ready' | 'failed';

export interface CompilerStatus {
  stage: CompilerLoadStage;
  loadedBytes?: number;
  /** Only known when the server reports an uncompressed Content-Length. */
  totalBytes?: number;
  message?: string;
}

export type CompilerStatusListener = (status: CompilerStatus) => void;

interface PendingCompile {
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
  timer: number;
}

type CompilerWorkerMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'compile-result';
      id: number;
      result: CompileResult;
    }
  | {
      type: 'compile-error';
      id: number;
      message: string;
    };

export class CompilerClient {
  private worker?: Worker;
  private workerPromise?: Promise<Worker>;
  // Production builds download the worker once and reuse the bytes when the worker restarts.
  private workerScriptPromise?: Promise<string>;
  private workerGeneration = 0;
  private requestId = 1;
  private readonly pendingCompiles = new Map<number, PendingCompile>();
  private readonly statusListeners = new Set<CompilerStatusListener>();
  private status: CompilerStatus = { stage: 'idle' };

  constructor() {
    this.handleMessage = this.handleMessage.bind(this);
    this.handleWorkerError = this.handleWorkerError.bind(this);
  }

  getStatus(): CompilerStatus {
    return this.status;
  }

  subscribe(listener: CompilerStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /** Starts downloading and booting the compiler without compiling anything. */
  preload(): void {
    this.getWorker().catch(() => undefined);
  }

  async compile(source: string): Promise<CompileResult> {
    // The timeout only covers the compile itself; downloading and booting the compiler can take much longer.
    const worker = await this.getWorker();
    const id = this.requestId++;

    return new Promise<CompileResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingCompiles.delete(id);
        reject(new Error('TypeScript compiler did not respond in time.'));
        // A pathological source can wedge the worker; restart it so later compiles still run.
        this.restartWorker(new Error('TypeScript compiler was restarted.'));
      }, COMPILE_TIMEOUT_MS);

      this.pendingCompiles.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'compile', id, source });
    });
  }

  dispose(): void {
    this.restartWorker(new Error('Compiler disposed.'));
    this.statusListeners.clear();
    void this.workerScriptPromise?.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
    this.workerScriptPromise = undefined;
  }

  private setStatus(status: CompilerStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private restartWorker(reason: Error): void {
    this.workerGeneration++;
    for (const pending of this.pendingCompiles.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pendingCompiles.clear();
    this.worker?.removeEventListener('message', this.handleMessage);
    this.worker?.removeEventListener('error', this.handleWorkerError);
    this.worker?.terminate();
    this.worker = undefined;
    this.workerPromise = undefined;
  }

  private getWorker(): Promise<Worker> {
    if (!this.workerPromise) {
      const generation = this.workerGeneration;
      this.workerPromise = this.startWorker(generation).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        // Let the next compile retry the download instead of caching the failure.
        if (generation === this.workerGeneration) {
          this.workerPromise = undefined;
          this.setStatus({ stage: 'failed', message: failure.message });
        }
        throw failure;
      });
    }
    return this.workerPromise;
  }

  private async startWorker(generation: number): Promise<Worker> {
    const scriptUrl = await this.getWorkerScriptUrl();
    if (generation !== this.workerGeneration) throw new Error('TypeScript compiler was restarted.');

    this.setStatus({ stage: 'starting' });
    // Dev serves the worker as an ES module; production emits a self-contained classic script.
    const worker = new Worker(scriptUrl, { type: import.meta.env.DEV ? 'module' : 'classic', name: 'TypeScript compiler' });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (!isCompilerWorkerMessage(event.data) || event.data.type !== 'ready') return;
        cleanup();
        resolve();
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || 'TypeScript compiler failed to start.'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
    }).catch((error: unknown) => {
      worker.terminate();
      throw error;
    });

    if (generation !== this.workerGeneration) {
      worker.terminate();
      throw new Error('TypeScript compiler was restarted.');
    }

    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleWorkerError);
    this.worker = worker;
    this.setStatus({ stage: 'ready' });
    return worker;
  }

  private getWorkerScriptUrl(): Promise<string> {
    // Vite serves the dev worker as a module graph, so there is no single file to track.
    if (import.meta.env.DEV) return Promise.resolve(compilerWorkerUrl);

    if (!this.workerScriptPromise) {
      this.workerScriptPromise = downloadScript(new URL(compilerWorkerUrl, import.meta.url).href, (loadedBytes, totalBytes) =>
        this.setStatus({ stage: 'downloading', loadedBytes, totalBytes }),
      ).catch((error: unknown) => {
        this.workerScriptPromise = undefined;
        throw error;
      });
    }
    return this.workerScriptPromise;
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (!isCompilerWorkerMessage(event.data) || event.data.type === 'ready') return;

    const pending = this.pendingCompiles.get(event.data.id);
    if (!pending) return;

    window.clearTimeout(pending.timer);
    this.pendingCompiles.delete(event.data.id);

    if (event.data.type === 'compile-result') {
      pending.resolve(event.data.result);
      return;
    }

    pending.reject(new Error(event.data.message));
  }

  private handleWorkerError(event: ErrorEvent): void {
    const error = new Error(event.message || 'TypeScript compiler failed.');
    for (const pending of this.pendingCompiles.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCompiles.clear();
  }
}

async function downloadScript(url: string, onProgress: (loadedBytes: number, totalBytes?: number) => void): Promise<string> {
  onProgress(0);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the TypeScript compiler (HTTP ${response.status}).`);

  // Content-Length is the compressed size when the response is encoded, so it can't be compared to decoded bytes.
  const encoding = response.headers.get('content-encoding');
  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = (!encoding || encoding === 'identity') && contentLength > 0 ? contentLength : undefined;

  const chunks: BlobPart[] = [];
  let loadedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress(loadedBytes, totalBytes);
    }
  } else {
    const blob = await response.blob();
    chunks.push(blob);
    loadedBytes = blob.size;
    onProgress(loadedBytes, totalBytes);
  }

  return URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
}

export function describeCompilerStatus(status: CompilerStatus): string | undefined {
  switch (status.stage) {
    case 'downloading': {
      const loaded = status.loadedBytes ?? 0;
      if (status.totalBytes) {
        const percent = Math.min(100, Math.round((loaded / status.totalBytes) * 100));
        return `Step 1/3 · Downloading TypeScript compiler ${formatMegabytes(loaded)} / ${formatMegabytes(status.totalBytes)} (${percent}%)`;
      }
      return loaded > 0
        ? `Step 1/3 · Downloading TypeScript compiler ${formatMegabytes(loaded)}`
        : 'Step 1/3 · Downloading TypeScript compiler';
    }
    case 'starting':
      return 'Step 2/3 · Starting TypeScript compiler';
    case 'failed':
      return `TypeScript compiler failed to load${status.message ? `: ${status.message}` : ''}`;
    default:
      return undefined;
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCompilerWorkerMessage(value: unknown): value is CompilerWorkerMessage {
  if (typeof value !== 'object' || value === null) return false;

  const message = value as CompilerWorkerMessage;
  if (message.type === 'ready') return true;

  if (message.type === 'compile-result') {
    return typeof message.id === 'number' && typeof message.result === 'object' && message.result !== null;
  }

  if (message.type === 'compile-error') {
    return typeof message.id === 'number' && typeof message.message === 'string';
  }

  return false;
}
