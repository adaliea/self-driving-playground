import type { RuntimeInspectionState } from '../sandbox/RuntimeInspectionStore';
import type { PidDebugTerms } from '../types';

export interface NamedPidTelemetry {
  id: string;
  name: string;
  terms: PidDebugTerms;
}

/** Read the same automatic PID observations used by editor hovers. */
export function pidTelemetryFromInspection(state: RuntimeInspectionState): NamedPidTelemetry[] {
  if (!state.snapshot || state.snapshot.version !== state.version) return [];

  return state.manifest.toolboxCalls.flatMap((call) => {
    if (call.name !== 'createPidController') return [];
    const debug = state.snapshot!.toolboxCalls[call.id]?.details?.debug;
    if (debug?.type !== 'object') return [];

    const terms = {} as PidDebugTerms;
    for (const key of ['error', 'proportional', 'integral', 'derivative', 'output'] as const) {
      const term = debug.properties[key];
      if (term?.type !== 'number' || typeof term.value !== 'number' || !Number.isFinite(term.value)) return [];
      terms[key] = term.value;
    }
    const binding = state.manifest.bindings.find((binding) => binding.sourceCallId === call.id);
    return [{ id: call.id, name: binding?.name ?? 'PID controller', terms }];
  });
}
