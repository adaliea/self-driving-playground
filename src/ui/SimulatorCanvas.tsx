import { forwardRef } from 'react';

export const SimulatorCanvas = forwardRef<HTMLCanvasElement>(function SimulatorCanvas(_, ref) {
  return (
    <div className="relative min-h-[360px] flex-1 overflow-hidden bg-ink">
      <canvas ref={ref} className="h-full min-h-[360px] w-full touch-none" />
    </div>
  );
});
