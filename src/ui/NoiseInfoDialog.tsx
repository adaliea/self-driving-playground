import { ArrowRight, Car } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './AlertDialog';

interface NoiseInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NoiseInfoDialog({ open, onOpenChange }: NoiseInfoDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[min(92vh,54rem)] w-[min(58rem,calc(100vw-2rem))] overflow-y-auto border-input bg-popover">
        <header className="sticky top-0 z-10 border-b border-border bg-popover px-5 py-4 sm:px-8">
          <AlertDialogTitle className="text-xl font-medium text-foreground">
            How vehicle measurement noise works
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            The camera estimates a box each frame. The tracker combines those estimates into a steadier position and velocity.
          </AlertDialogDescription>
        </header>

        <article className="px-5 py-7 text-foreground sm:px-8 sm:py-8">
          <FrameSequence />

          <section className="mt-7 grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3">
            <DarkNote title="Distance amplifies error">
              Far cars occupy fewer pixels, so depth and angle vary more than side-to-side position.
            </DarkNote>
            <DarkNote title="Most jitter is temporary">
              About 95% of the variance is fresh each frame, so repeated observations can average it down.
            </DarkNote>
            <DarkNote title="A little error persists">
              About 5% is slow bias from effects such as calibration, lighting, or road slope. It is intentionally modest.
            </DarkNote>
          </section>

          <FilterExplanation />
          <InputMap />

          <section className="mt-8 border-t border-border pt-6">
            <h2 className="text-lg font-medium">Other settings</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <SettingNote name="Seed" effect="Chooses the repeatable road, traffic, and noise sequence. It applies after Reset." />
              <SettingNote name="Traffic" effect="Changes how many vehicles exist, so it changes both vehicle input arrays. It updates live." />
              <SettingNote name="Start speed" effect="Sets the initial ego.speed after Reset; it does not add sensor noise." />
              <SettingNote name="Actuator variation" effect="Changes how commands affect vehicle physics. It does not directly modify AutopilotInput, but later ego and sensor values reflect the resulting motion." />
              <SettingNote name="Steer / Accelerate for me" effect="Do not alter the input. They replace the matching controller output after autopilot() returns." />
              <SettingNote name="Debug overlays" effect="Only changes what is drawn on the canvas. It does not change simulation or controller data." />
            </div>
          </section>
        </article>

        <div className="sticky bottom-0 flex justify-end border-t border-border bg-popover px-6 py-3">
          <AlertDialogCancel className="mt-0">Close</AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FrameSequence() {
  return (
    <section aria-labelledby="frames-heading">
      <div className="max-w-3xl">
        <h2 id="frames-heading" className="text-lg font-medium">
          The car is steady. The measurements are not.
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Each dashed amber box is a fresh camera estimate. The solid mint track follows their shared motion instead of chasing every small jump.
        </p>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <FilmFrame index="001" offset="-translate-x-2 rotate-[-4deg]" />
        <FilmFrame index="002" offset="translate-x-1 rotate-[2deg]" />
        <FilmFrame index="003" offset="-translate-x-0.5 rotate-[-1deg]" tracked />
      </div>
    </section>
  );
}

function FilterExplanation() {
  return (
    <section className="mt-8 border-y border-border py-7">
      <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <FilterStep number="1" title="Predict from position + velocity">
          Carry the previous track forward. This bridges short missed detections, but its uncertainty grows while no box is seen.
        </FilterStep>
        <StepArrow />
        <FilterStep number="2" title="Compare with the new box">
          Measure the residual—the distance between the predicted location and the latest camera measurement.
        </FilterStep>
        <StepArrow />
        <FilterStep number="3" title="Correct according to uncertainty">
          Trust a precise new box more. Trust the prediction more when the measurement is noisy or far away.
        </FilterStep>
      </div>
      <p className="mt-5 max-w-3xl text-xs leading-5 text-muted-foreground">
        This repeats every frame. Filtering reduces random jitter without pretending the sensor is exact; persistent bias can remain, and a track is removed if a measurement is missing for more than 420 ms.
      </p>
    </section>
  );
}

function InputMap() {
  return (
    <section className="mt-8">
      <div className="max-w-3xl">
        <h2 className="text-lg font-medium">What the two noise settings change in <code className="font-mono text-base">autopilot(input)</code></h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Both settings change sensor fields before your controller runs. Vehicle data offers both stages; lane data currently offers only the direct detection.
        </p>
      </div>

      <div className="mt-5 overflow-hidden rounded-md border border-border">
        <InputRow
          setting="Noisy vehicle poses"
          field="input.vehicleMeasurements"
          status="Raw, not filtered"
          tone="raw"
        >
          When on, position, rotation, size, confidence, and uncertainty vary with distance, and measurements may briefly disappear. When off, these observations use exact simulated geometry.
        </InputRow>
        <InputRow
          setting="Noisy vehicle poses"
          field="input.vehicles"
          status="Pre-filtered tracks"
          tone="track"
        >
          Always produced by the built-in constant-velocity tracker. With noise on it smooths measurements and predicts through short dropouts; with noise off it tracks exact observations.
        </InputRow>
        <InputRow
          setting="Noisy lane lines"
          field="input.laneLines"
          status="Raw, not filtered over time"
          tone="raw"
        >
          When on, individual lane samples jitter, lose confidence, or disappear—especially farther ahead. When off, the samples match the simulated road. No built-in tracker smooths them over time.
        </InputRow>
      </div>
    </section>
  );
}

function FilmFrame({ index, offset, tracked = false }: { index: string; offset: string; tracked?: boolean }) {
  return (
    <figure className="rounded-md border border-border bg-background p-2">
      <div className="relative h-40 overflow-hidden rounded-sm bg-card">
        <div className="absolute inset-y-0 left-1/2 w-20 -translate-x-1/2 border-x border-input" />
        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-input" />
        <div className="absolute left-1/2 top-1/2 flex h-14 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm bg-[#dce8ee] text-background"><Car size={15} /></div>
        <div className={`absolute left-1/2 top-1/2 h-16 w-10 -translate-x-1/2 -translate-y-1/2 border-2 border-dashed border-warning ${offset}`} />
        {tracked ? <div className="absolute left-1/2 top-1/2 h-16 w-10 -translate-x-1/2 -translate-y-1/2 border-2 border-signal" /> : null}
      </div>
      <figcaption className="flex justify-between px-0.5 pt-2 text-xs text-muted-foreground">
        <span>Frame {index}</span><span>{tracked ? 'track added' : 'raw detection'}</span>
      </figcaption>
    </figure>
  );
}

function DarkNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-popover p-4">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{children}</p>
    </section>
  );
}

function FilterStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-muted-foreground">{number}.</span>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{children}</p>
    </section>
  );
}

function StepArrow() {
  return <div className="flex items-center justify-center"><ArrowRight className="rotate-90 text-muted-foreground/50 md:rotate-0" size={18} /></div>;
}

function InputRow({ setting, field, status, tone, children }: { setting: string; field: string; status: string; tone: 'raw' | 'track'; children: ReactNode }) {
  const badge = tone === 'track' ? 'text-signal' : 'text-warning';
  return (
    <section className="grid gap-3 border-b border-border p-4 last:border-b-0 md:grid-cols-[10rem_13rem_1fr] md:items-start">
      <div className="text-sm text-foreground">{setting}</div>
      <div><code className="font-mono text-xs text-foreground">{field}</code><div className={`mt-1 text-xs ${badge}`}>{status}</div></div>
      <p className="text-xs leading-5 text-muted-foreground">{children}</p>
    </section>
  );
}

function SettingNote({ name, effect }: { name: string; effect: string }) {
  return <section><h3 className="text-sm font-medium text-foreground">{name}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{effect}</p></section>;
}
