import type { RuntimeInspectionState } from '../sandbox/RuntimeInspectionStore';
import type { PidDebugTerms } from '../types';

export interface NamedPidTelemetry {
  id: string;
  name: string;
  terms: Partial<PidDebugTerms>;
}

/** Read the same automatic PID observations used by editor hovers. */
export function pidTelemetryFromInspection(state: RuntimeInspectionState): NamedPidTelemetry[] {
  if (state.snapshot && state.snapshot.version !== state.version) return [];

  return state.manifest.toolboxCalls.flatMap((call) => {
    if (call.name !== 'createPidController') return [];
    const debug = state.snapshot?.toolboxCalls[call.id]?.details?.debug;
    const terms: Partial<PidDebugTerms> = {};
    for (const key of ['error', 'proportional', 'integral', 'derivative', 'output'] as const) {
      const term = debug?.type === 'object' ? debug.properties[key] : undefined;
      if (term?.type === 'number' && typeof term.value === 'number' && Number.isFinite(term.value)) {
        terms[key] = term.value;
      }
    }
    const binding = state.manifest.bindings.find((binding) => binding.sourceCallId === call.id);
    return [{ id: call.id, name: binding?.name ?? 'PID controller', terms }];
  });
}
