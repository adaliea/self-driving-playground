import type { AutopilotInput } from '../types';
import type { RuntimeInspectionSnapshot } from './inspection';
import { isSandboxFromFrameMessage, type GraphValues, type SandboxFromFrameMessage, type SandboxToFrameMessage } from './protocol';

export interface SandboxRunResult {
  output: unknown;
  durationMs: number;
  inspection?: RuntimeInspectionSnapshot;
  graphs?: GraphValues;
}

interface PendingRun {
  resolve: (value: SandboxRunResult) => void;
  reject: (error: Error) => void;
  timer: number;
}

interface PendingLoad {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

export class SandboxClient {
  private iframe?: HTMLIFrameElement;
  private ready = false;
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pendingRuns = new Map<number, PendingRun>();
  private readonly pendingLoads = new Map<number, PendingLoad>();
  private requestId = 1;
  private version = 1;

  constructor(private readonly src = '/sandbox.html') {
    this.handleMessage = this.handleMessage.bind(this);
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const iframe = document.createElement('iframe');
      iframe.src = this.src;
      iframe.sandbox.add('allow-scripts');
      iframe.referrerPolicy = 'no-referrer';
      iframe.title = 'Autopilot code sandbox';
      iframe.style.position = 'absolute';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.addEventListener('error', () => reject(new Error('Code runner failed to load.')));
      this.iframe = iframe;
      window.addEventListener('message', this.handleMessage);
      document.body.appendChild(iframe);

      window.setTimeout(() => {
        if (!this.ready) reject(new Error('Code runner did not become ready in time.'));
      }, 2500);
    });

    return this.readyPromise;
  }

  async loadCode(js: string): Promise<number> {
    await this.start();
    const version = this.version++;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingLoads.delete(version);
        reject(new Error('Code runner did not load code in time.'));
      }, 5000);

      this.pendingLoads.set(version, { resolve, reject, timer });
      this.send({ type: 'load-code', version, js });
    });
    return version;
  }

  async run(input: AutopilotInput, timeoutMs = 24, inspect = true): Promise<SandboxRunResult> {
    await this.start();
    const id = this.requestId++;

    // The runner executes one run at a time, so a run sent behind others also waits out their budgets.
    const queuedAhead = this.pendingRuns.size;
    return new Promise<SandboxRunResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRuns.delete(id);
        reject(new Error('Autopilot code timed out.'));
      }, timeoutMs * (queuedAhead + 1) + 80);

      this.pendingRuns.set(id, { resolve, reject, timer });
      this.send({ type: 'run-autopilot', id, input, timeoutMs, inspect });
    });
  }

  dispose(): void {
    window.removeEventListener('message', this.handleMessage);
    for (const pending of this.pendingRuns.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Sandbox disposed.'));
    }
    for (const pending of this.pendingLoads.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Sandbox disposed.'));
    }
    this.pendingRuns.clear();
    this.pendingLoads.clear();
    this.iframe?.remove();
    this.iframe = undefined;
    this.ready = false;
  }

  private send(message: SandboxToFrameMessage): void {
    this.iframe?.contentWindow?.postMessage(message, '*');
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    if (!isSandboxFromFrameMessage(event.data)) return;

    const message = event.data;
    if (message.type === 'sandbox-ready') {
      this.ready = true;
      this.readyResolve?.();
      return;
    }

    this.handleSandboxMessage(message);
  }

  private handleSandboxMessage(message: Exclude<SandboxFromFrameMessage, { type: 'sandbox-ready' }>): void {
    switch (message.type) {
      case 'code-loaded': {
        const pending = this.pendingLoads.get(message.version);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingLoads.delete(message.version);
        pending.resolve();
        break;
      }
      case 'code-load-error': {
        const pending = this.pendingLoads.get(message.version);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingLoads.delete(message.version);
        pending.reject(new Error(message.message));
        break;
      }
      case 'run-result': {
        const pending = this.pendingRuns.get(message.id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingRuns.delete(message.id);
        pending.resolve({
          output: message.output,
          durationMs: message.durationMs,
          inspection: message.inspection,
          graphs: message.graphs,
        });
        break;
      }
      case 'run-error': {
        const pending = this.pendingRuns.get(message.id);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingRuns.delete(message.id);
        pending.reject(new Error(message.stack ? `${message.message}\n${message.stack}` : message.message));
        break;
      }
    }
  }
}
