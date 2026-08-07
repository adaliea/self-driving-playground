import CompilerWorker from './compiler.worker?worker';
import type { CompileResult } from './compiler';

interface PendingCompile {
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
  timer: number;
}

type CompilerWorkerMessage =
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
  private requestId = 1;
  private readonly pendingCompiles = new Map<number, PendingCompile>();

  constructor() {
    this.handleMessage = this.handleMessage.bind(this);
    this.handleWorkerError = this.handleWorkerError.bind(this);
  }

  compile(source: string): Promise<CompileResult> {
    const worker = this.getWorker();
    const id = this.requestId++;

    return new Promise<CompileResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingCompiles.delete(id);
        reject(new Error('TypeScript compiler did not respond in time.'));
      }, 10000);

      this.pendingCompiles.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'compile', id, source });
    });
  }

  dispose(): void {
    for (const pending of this.pendingCompiles.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Compiler disposed.'));
    }
    this.pendingCompiles.clear();
    this.worker?.removeEventListener('message', this.handleMessage);
    this.worker?.removeEventListener('error', this.handleWorkerError);
    this.worker?.terminate();
    this.worker = undefined;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new CompilerWorker();
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleWorkerError);
    this.worker = worker;
    return worker;
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (!isCompilerWorkerMessage(event.data)) return;

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

function isCompilerWorkerMessage(value: unknown): value is CompilerWorkerMessage {
  if (typeof value !== 'object' || value === null) return false;

  const message = value as CompilerWorkerMessage;
  if (message.type === 'compile-result') {
    return typeof message.id === 'number' && typeof message.result === 'object' && message.result !== null;
  }

  if (message.type === 'compile-error') {
    return typeof message.id === 'number' && typeof message.message === 'string';
  }

  return false;
}
