import type { InspectionManifest, RuntimeInspectionSnapshot } from './inspection';

export interface RuntimeInspectionState {
  version?: number;
  manifest: InspectionManifest;
  snapshot?: RuntimeInspectionSnapshot;
  running: boolean;
}

const emptyManifest: InspectionManifest = { bindings: [], toolboxCalls: [] };

export class RuntimeInspectionStore {
  private state: RuntimeInspectionState = {
    manifest: emptyManifest,
    running: false,
  };

  private readonly listeners = new Set<() => void>();

  getState(): RuntimeInspectionState {
    return this.state;
  }

  setProgram(version: number, manifest: InspectionManifest): void {
    this.state = { ...this.state, version, manifest, snapshot: undefined };
    this.emit();
  }

  clearProgram(): void {
    this.state = { manifest: emptyManifest, running: this.state.running };
    this.emit();
  }

  setRunning(running: boolean): void {
    if (this.state.running === running) return;
    this.state = { ...this.state, running };
    this.emit();
  }

  updateSnapshot(snapshot: RuntimeInspectionSnapshot): void {
    if (snapshot.version !== this.state.version) return;
    this.state = { ...this.state, snapshot };
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
