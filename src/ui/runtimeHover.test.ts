import { describe, expect, it } from 'vitest';
import { RuntimeInspectionStore } from '../sandbox';
import type { RuntimeToolboxInspection, RuntimeValuePreview } from '../sandbox/inspection';
import { runtimeValueWidgetCoordinates } from './RuntimeValueWidget';
import {
  formatGenericValue,
  formatToolboxInspection,
  previewAtPath,
  provideRuntimeHover,
  resolveRuntimeHoverTarget,
  runtimeHoverForTarget,
} from './runtimeHover';

describe('runtime hover formatting', () => {
  it('keeps the live-value card inside the editor above its footer', () => {
    expect(runtimeValueWidgetCoordinates({
      width: 900,
      height: 500,
      verticalScrollbarWidth: 10,
      horizontalScrollbarHeight: 10,
    }, 380, 240)).toEqual({ left: 498, top: 238 });
  });

  it('resolves captured property chains', () => {
    const lane: RuntimeValuePreview = {
      type: 'object',
      properties: {
        centerOffset: { type: 'number', value: -0.184 },
        confidence: { type: 'number', value: 0.92 },
      },
    };

    expect(previewAtPath(lane, ['centerOffset'])).toEqual({ type: 'number', value: -0.184 });
    expect(formatGenericValue('lane.centerOffset', previewAtPath(lane, ['centerOffset']), Date.now(), true))
      .toContain('lane.centerOffset = -0.184');
  });

  it('formats lane toolbox values with domain units', () => {
    const inspection: RuntimeToolboxInspection = {
      id: 'c:1',
      name: 'analyzeLane',
      observedAt: Date.now(),
      args: [],
      result: { type: 'object', properties: {} },
      details: {
        centerOffset: { type: 'number', value: 0.25 },
        heading: { type: 'number', value: Math.PI / 180 },
        curvature: { type: 'number', value: 0.0012 },
        confidence: { type: 'number', value: 0.9 },
        relativeTargetLane: { type: 'number', value: 0 },
      },
    };

    const markdown = formatToolboxInspection(inspection, true, 'lane');
    expect(markdown).toContain('Lane analysis');
    expect(markdown).toContain('0.25 m · right of ego');
    expect(markdown).toContain('1°');
    expect(markdown).toContain('90%');
  });

  it('resolves a property hover through its base variable definition', async () => {
    const source = 'const lane = getLane();\nlane.centerOffset;';
    const store = new RuntimeInspectionStore();
    store.setProgram(1, {
      bindings: [{ id: 'b:6', name: 'lane', declaration: { start: 6, length: 4 } }],
      toolboxCalls: [],
    });
    store.setRunning(true);
    store.updateSnapshot({
      version: 1,
      capturedAt: Date.now(),
      bindings: {
        'b:6': {
          observedAt: Date.now(),
          value: { type: 'object', properties: { centerOffset: { type: 'number', value: -0.184 } } },
        },
      },
      toolboxCalls: {},
    });

    const lines = source.split('\n');
    const model = {
      uri: { toString: () => 'file:///autopilot.ts' },
      getLineContent: (lineNumber: number) => lines[lineNumber - 1],
      getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) =>
        lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + column - 1,
    };
    class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    }
    const monaco = {
      Range,
      languages: {
        typescript: {
          getTypeScriptWorker: async () => async () => ({
            getDefinitionAtPosition: async () => [{ fileName: 'file:///autopilot.ts', textSpan: { start: 6, length: 4 } }],
          }),
        },
      },
    };

    const hover = await provideRuntimeHover(
      monaco as never,
      model as never,
      { lineNumber: 2, column: 8 } as never,
      store,
    );
    expect(hover?.contents[0].value).toContain('lane.centerOffset = -0.184');
  });

  it('updates a resolved target from new snapshots without resolving TypeScript again', async () => {
    const source = 'const lane = getLane();\nlane.centerOffset;';
    const store = new RuntimeInspectionStore();
    store.setProgram(1, {
      bindings: [{ id: 'b:6', name: 'lane', declaration: { start: 6, length: 4 } }],
      toolboxCalls: [],
    });
    const lines = source.split('\n');
    const model = {
      uri: { toString: () => 'file:///autopilot.ts' },
      getLineContent: (lineNumber: number) => lines[lineNumber - 1],
      getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) =>
        lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + column - 1,
    };
    class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    }
    let definitionRequests = 0;
    const monaco = {
      Range,
      languages: {
        typescript: {
          getTypeScriptWorker: async () => async () => ({
            getDefinitionAtPosition: async () => {
              definitionRequests += 1;
              return [{ fileName: 'file:///autopilot.ts', textSpan: { start: 6, length: 4 } }];
            },
          }),
        },
      },
    };

    const target = await resolveRuntimeHoverTarget(
      monaco as never,
      model as never,
      { lineNumber: 2, column: 8 } as never,
      store,
    );
    expect(target).toBeDefined();

    store.updateSnapshot({
      version: 1,
      capturedAt: Date.now(),
      bindings: { 'b:6': { observedAt: Date.now(), value: { type: 'object', properties: { centerOffset: { type: 'number', value: 0.1 } } } } },
      toolboxCalls: {},
    });
    expect(runtimeHoverForTarget(monaco as never, target!, store)?.contents[0].value).toContain('lane.centerOffset = 0.1');

    store.updateSnapshot({
      version: 1,
      capturedAt: Date.now(),
      bindings: { 'b:6': { observedAt: Date.now(), value: { type: 'object', properties: { centerOffset: { type: 'number', value: 0.2 } } } } },
      toolboxCalls: {},
    });
    expect(runtimeHoverForTarget(monaco as never, target!, store)?.contents[0].value).toContain('lane.centerOffset = 0.2');
    expect(definitionRequests).toBe(1);
  });
});
