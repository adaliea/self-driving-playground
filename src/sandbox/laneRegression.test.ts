import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import sandboxHtml from '../../public/sandbox.html?raw';
import { analyzeLaneDetectionsForTarget } from '../simulation/controllers';
import { clampImplementation } from '../toolbox/library';
import type { LaneAnalysis, LaneLineDetections } from '../types';

// Execute the helper source shipped to the sandbox, including the toolbox wrapper.
const helperStart = sandboxHtml.indexOf('const __clamp =');
const helperEnd = sandboxHtml.indexOf('${code}', helperStart);
const toolbox = ts.transpileModule(clampImplementation, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const { regression } = new Function(
  sandboxHtml.slice(helperStart, helperEnd) + toolbox +
  '\nreturn { regression: analyzeLane };',
)() as {
  regression: (lines: LaneLineDetections, relativeLane?: number, mode?: 'local' | 'preview') => LaneAnalysis;
};

function linesFor(center: (y: number) => number): LaneLineDetections {
  const boundary = (offset: number) => Array.from({ length: 46 }, (_, i) => {
    const y = 3 + 2 * i;
    return { x: center(y) + offset, y, confidence: 1 };
  });
  return { left: boundary(-1.85), right: boundary(1.85), farLeft: boundary(-5.55), farRight: boundary(5.55) };
}

describe('user-facing lane regression', () => {
  it.each([-1, 1])('keeps distant turn entry and exit out of local steering (direction %s)', (sign) => {
    const entry = linesFor((y) => sign * 0.01 * Math.max(0, y - 24) ** 2);
    expect(regression(entry).curvature).toBeCloseTo(0, 8);
    expect(regression(entry).centerOffset).toBeCloseTo(0, 8);
    expect(sign * regression(entry, 0, 'preview').curvature).toBeGreaterThan(0.005);

    const continuing = regression(linesFor((y) => sign * 0.01 * y * y));
    const exiting = regression(linesFor((y) => sign * 0.01 * (y * y - Math.max(0, y - 24) ** 2)));
    for (const field of ['centerOffset', 'heading', 'curvature', 'confidence'] as const) {
      expect(exiting[field]).toBeCloseTo(continuing[field], 10);
    }
  });

  it('estimates position and heading at ego instead of a forward point', () => {
    const lane = regression(linesFor((y) => 0.4 + 0.05 * y));
    expect(lane.centerOffset).toBeCloseTo(0.4, 8);
    expect(lane.heading).toBeCloseTo(Math.atan(0.05), 8);
    expect(lane.curvature).toBeCloseTo(0, 8);
  });

  it.each([-1, 0, 1])('matches simulator geometry for lane %s', (relativeLane) => {
    const lines = linesFor((y) => 0.2 + 0.03 * y + 0.008 * Math.max(0, y - 24) ** 2);
    for (const mode of ['local', 'preview'] as const) {
      const lane = regression(lines, relativeLane, mode);
      const simulationLane = analyzeLaneDetectionsForTarget(lines, relativeLane, mode);
      for (const field of ['centerOffset', 'heading', 'curvature', 'confidence'] as const) {
        expect(lane[field]).toBeCloseTo(simulationLane[field], 10);
      }
    }
  });

  it('supports a missing boundary and reports missing detections', () => {
    const lines = linesFor(() => 0.4);
    lines.left = [];
    expect(regression(lines).centerOffset).toBeCloseTo(0.4, 8);
    expect(regression(lines).confidence).toBeGreaterThan(0);
    lines.right = [];
    expect(regression(lines)).toEqual({ centerOffset: 0, heading: 0, curvature: 0, confidence: 0 });
  });
});
