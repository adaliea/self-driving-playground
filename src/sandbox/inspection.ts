export const INSPECTION_SAMPLE_INTERVAL_MS = 100;

export const TOOLBOX_INSPECTORS = [
  'createPidController',
  'createVehicleTracker',
  'analyzeLane',
  'analyzeLaneRegression',
  'closestVehicleAhead',
  'adaptiveCruiseTargetSpeed',
  'accelerationFeedforward',
  'curvatureSteeringFeedforward',
  'clamp',
] as const;

export type ToolboxInspectorName = (typeof TOOLBOX_INSPECTORS)[number];

export interface SourceSpan {
  start: number;
  length: number;
}

export interface RuntimeBindingMetadata {
  id: string;
  name: string;
  declaration: SourceSpan;
  sourceCallId?: string;
}

export interface ToolboxCallMetadata {
  id: string;
  name: ToolboxInspectorName;
  span: SourceSpan;
}

export interface InspectionManifest {
  bindings: RuntimeBindingMetadata[];
  toolboxCalls: ToolboxCallMetadata[];
}

export type RuntimeValuePreview =
  | { type: 'undefined' }
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number | string }
  | { type: 'bigint'; value: string }
  | { type: 'string'; value: string; truncated?: boolean }
  | { type: 'function'; name?: string }
  | { type: 'symbol'; value: string }
  | { type: 'reference'; path: string }
  | { type: 'array'; items: RuntimeValuePreview[]; length: number; truncated?: boolean }
  | {
      type: 'object';
      name?: string;
      properties: Record<string, RuntimeValuePreview>;
      truncated?: boolean;
    }
  | { type: 'unavailable'; reason: string };

export interface RuntimeToolboxInspection {
  id: string;
  name: ToolboxInspectorName;
  observedAt: number;
  args: RuntimeValuePreview[];
  result: RuntimeValuePreview;
  details?: Record<string, RuntimeValuePreview>;
}

export interface RuntimeObservedValue {
  observedAt: number;
  value: RuntimeValuePreview;
}

export interface RuntimeInspectionSnapshot {
  version: number;
  capturedAt: number;
  bindings: Record<string, RuntimeObservedValue>;
  toolboxCalls: Record<string, RuntimeToolboxInspection>;
}
