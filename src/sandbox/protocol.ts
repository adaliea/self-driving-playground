import type { AutopilotInput } from '../types';
import type { RuntimeInspectionSnapshot } from './inspection';

export interface SandboxReadyMessage {
  type: 'sandbox-ready';
}

export interface SandboxLoadedMessage {
  type: 'code-loaded';
  version: number;
}

export interface SandboxLoadErrorMessage {
  type: 'code-load-error';
  version: number;
  message: string;
}

export interface SandboxRunResultMessage {
  type: 'run-result';
  id: number;
  output: unknown;
  durationMs: number;
  inspection?: RuntimeInspectionSnapshot;
  /** Values recorded with graph(name, value, unit?) during this call. */
  graphs?: GraphValues;
}

/** One autopilot call's graph(...) values, keyed by graph name. */
export type GraphValues = Record<string, { value: number; unit?: string }>;

export interface SandboxRunErrorMessage {
  type: 'run-error';
  id: number;
  message: string;
  stack?: string;
}

export type SandboxFromFrameMessage =
  | SandboxReadyMessage
  | SandboxLoadedMessage
  | SandboxLoadErrorMessage
  | SandboxRunResultMessage
  | SandboxRunErrorMessage;

export type SandboxToFrameMessage =
  | {
      type: 'load-code';
      version: number;
      js: string;
    }
  | {
      type: 'run-autopilot';
      id: number;
      input: AutopilotInput;
      timeoutMs: number;
      /** Set false to skip capturing runtime values for the editor. */
      inspect?: boolean;
    };

export function isSandboxFromFrameMessage(value: unknown): value is SandboxFromFrameMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'sandbox-ready':
      return true;
    case 'code-loaded':
      return typeof value.version === 'number';
    case 'code-load-error':
      return typeof value.version === 'number' && typeof value.message === 'string';
    case 'run-result':
      return (
        typeof value.id === 'number' &&
        typeof value.durationMs === 'number' &&
        (value.inspection === undefined || isRuntimeInspectionSnapshot(value.inspection)) &&
        (value.graphs === undefined || isRecord(value.graphs))
      );
    case 'run-error':
      return typeof value.id === 'number' && typeof value.message === 'string';
    default:
      return false;
  }
}

function isRuntimeInspectionSnapshot(value: unknown): value is RuntimeInspectionSnapshot {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    typeof value.capturedAt === 'number' &&
    isRecord(value.bindings) &&
    isRecord(value.toolboxCalls)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
