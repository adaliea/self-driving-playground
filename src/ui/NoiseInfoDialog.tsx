import { Activity, ArrowRight, Camera, Car, Clock3, EyeOff, Ruler } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './AlertDialog';

interface NoiseInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NoiseInfoDialog({ open, onOpenChange }: NoiseInfoDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[min(90vh,52rem)] w-[min(52rem,calc(100vw-2rem))] overflow-y-auto">
        <AlertDialogHeader className="border-b border-border bg-[radial-gradient(circle_at_top_right,rgba(109,247,209,0.10),transparent_38%)]">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300">
            <Camera size={14} />
            Perception, in plain language
          </div>
          <AlertDialogTitle className="text-xl">Why the camera view is imperfect</AlertDialogTitle>
          <AlertDialogDescription className="max-w-2xl leading-6">
            A camera sees a flat picture. The vision system has to guess where each car sits in 3D space, then a tracker combines those guesses over time.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-6 p-6">
          <PerceptionPipeline />

          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground">What changes the measurement?</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <ExplanationCard
                icon={<Ruler />}
                title="Farther cars are harder"
                body="A distant car occupies fewer pixels. Side-to-side position stays fairly clear, but judging how far ahead it is becomes much less precise."
              />
              <ExplanationCard
                icon={<Activity />}
                title="Most noise is momentary"
                body="Each camera frame lands a little differently. Most of that error is fresh on every frame, so a tracker—and your controller—can average it out."
              />
              <ExplanationCard
                icon={<EyeOff />}
                title="A box can briefly disappear"
                body="Glare, overlap, or a difficult angle can hide a raw observation for a few frames. The track keeps moving from its last known speed instead of vanishing immediately."
              />
              <ExplanationCard
                icon={<Clock3 />}
                title="A small bias can linger"
                body="Some errors drift in the same direction briefly, but this component is intentionally small. It demonstrates that filtering is not magic without making the lesson frustrating."
              />
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-emerald-400/15 bg-emerald-400/[0.045]">
            <div className="grid sm:grid-cols-[1fr_1.25fr]">
              <div className="border-b border-emerald-400/15 p-4 sm:border-b-0 sm:border-r">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">The teaching goal</div>
                <p className="mt-2 text-sm leading-6 text-foreground">
                  Enough imperfection to reward safe following distances and stable control, but not so much that the learner has no useful signal.
                </p>
              </div>
              <div className="p-4 text-sm leading-6 text-muted-foreground">
                Raw measurements contain position, rotation, size, confidence, and uncertainty. The built-in tracker estimates velocity, smooths the box, and predicts through short gaps. Advanced examples can build a different tracker from <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs text-emerald-200">input.vehicleMeasurements</code>.
              </div>
            </div>
          </section>

          <details className="group rounded-lg border border-border bg-background px-4 py-3 text-sm">
            <summary className="cursor-pointer select-none font-medium text-foreground marker:text-emerald-300">
              Exact simulator choices
            </summary>
            <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs leading-5 text-muted-foreground sm:grid-cols-2">
              <Fact label="Independent noise" value="About 95% of the total variance" />
              <Fact label="Slowly correlated bias" value="About 5% of the total variance" />
              <Fact label="Raw dropout burst" value="Usually 55–220 milliseconds" />
              <Fact label="Track coast window" value="Up to 420 milliseconds" />
              <Fact label="Error with distance" value="Depth and rotation grow fastest" />
              <Fact label="Repeatability" value="The same seed gives the same run" />
            </div>
          </details>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel className="mt-0">Got it</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PerceptionPipeline() {
  return (
    <section aria-label="From a real vehicle to a tracked estimate" className="rounded-xl border border-border bg-[#071013] p-3 sm:p-4">
      <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <PipelineStage label="What is there" caption="The simulated car" tone="neutral">
          <div className="relative h-24 overflow-hidden rounded-lg border border-white/5 bg-[#101a1d]">
            <div className="absolute inset-y-0 left-1/2 w-14 -translate-x-1/2 border-x border-white/10 bg-white/[0.025]" />
            <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-white/20" />
            <div className="absolute left-1/2 top-1/2 flex h-10 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[4px] bg-slate-200 shadow-[0_0_16px_rgba(226,232,240,0.16)]">
              <Car size={13} className="text-slate-800" />
            </div>
          </div>
        </PipelineStage>

        <PipelineArrow label="camera guesses" />

        <PipelineStage label="Raw measurement" caption="Amber dashed box" tone="amber">
          <div className="relative h-24 overflow-hidden rounded-lg border border-amber-300/10 bg-amber-300/[0.025]">
            <div className="absolute left-[48%] top-[44%] h-11 w-6 -translate-x-1/2 -translate-y-1/2 rotate-[-5deg] border border-dashed border-amber-300/25" />
            <div className="absolute left-[56%] top-[54%] h-11 w-6 -translate-x-1/2 -translate-y-1/2 rotate-[4deg] border border-dashed border-amber-300/35" />
            <div className="absolute left-1/2 top-1/2 h-11 w-6 -translate-x-1/2 -translate-y-1/2 rotate-[-1deg] border-2 border-dashed border-amber-300 bg-amber-300/10 shadow-[0_0_18px_rgba(247,200,109,0.14)]" />
            <div className="absolute bottom-2 left-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-200/80">changes each frame</div>
          </div>
        </PipelineStage>

        <PipelineArrow label="tracker combines" />

        <PipelineStage label="Vehicle track" caption="Cyan stable estimate" tone="cyan">
          <div className="relative h-24 overflow-hidden rounded-lg border border-emerald-300/10 bg-emerald-300/[0.025]">
            <div className="absolute left-1/2 top-1/2 h-16 w-12 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-emerald-300/35" />
            <div className="absolute left-1/2 top-1/2 h-11 w-6 -translate-x-1/2 -translate-y-1/2 border-2 border-emerald-300 bg-emerald-300/10 shadow-[0_0_20px_rgba(109,247,209,0.16)]" />
            <div className="absolute bottom-2 left-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-emerald-200/80">box + uncertainty</div>
          </div>
        </PipelineStage>
      </div>
    </section>
  );
}

function PipelineStage({
  label,
  caption,
  tone,
  children,
}: {
  label: string;
  caption: string;
  tone: 'neutral' | 'amber' | 'cyan';
  children: React.ReactNode;
}) {
  const labelColor = tone === 'amber' ? 'text-amber-200' : tone === 'cyan' ? 'text-emerald-200' : 'text-slate-200';
  return (
    <div className="min-w-0">
      {children}
      <div className={`mt-2 text-[10px] font-semibold uppercase tracking-[0.18em] ${labelColor}`}>{label}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{caption}</div>
    </div>
  );
}

function PipelineArrow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:w-16 sm:flex-col sm:py-0 sm:text-center">
      <span>{label}</span>
      <ArrowRight size={15} className="rotate-90 text-emerald-300/65 sm:rotate-0" />
    </div>
  );
}

function ExplanationCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <article className="flex gap-3 rounded-lg border border-border bg-background p-3.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-300 [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </div>
      <div>
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
      <span>{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
