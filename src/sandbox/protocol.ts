import type { AutopilotInput } from '../types';

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
}

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
      return typeof value.id === 'number' && typeof value.durationMs === 'number';
    case 'run-error':
      return typeof value.id === 'number' && typeof value.message === 'string';
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
