import { Activity, ArrowRight, Camera, Car, Clock3, Ruler } from 'lucide-react';
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
      <AlertDialogContent className="max-h-[min(92vh,54rem)] w-[min(58rem,calc(100vw-2rem))] overflow-y-auto border-zinc-700 bg-[#0d1014]">
        <header className="sticky top-0 z-10 border-b border-zinc-700 bg-[#0d1014] px-5 py-4 sm:px-8">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300">
            <Camera size={14} /> Vehicle perception
          </div>
          <AlertDialogTitle className="mt-2 text-xl font-medium text-zinc-100 sm:text-2xl">
            How vehicle measurement noise works
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            The camera estimates a box each frame. The tracker combines those estimates into a steadier position and velocity.
          </AlertDialogDescription>
        </header>

        <article className="px-5 py-7 text-zinc-100 sm:px-8 sm:py-9">
          <FrameSequence />

          <section className="mt-7 grid gap-px overflow-hidden rounded-lg border border-zinc-700 bg-zinc-700 sm:grid-cols-3">
            <DarkNote icon={<Ruler />} title="Distance amplifies error">
              Far cars occupy fewer pixels, so depth and angle vary more than side-to-side position.
            </DarkNote>
            <DarkNote icon={<Activity />} title="Most jitter is temporary">
              About 95% of the variance is fresh each frame, so repeated observations can average it down.
            </DarkNote>
            <DarkNote icon={<Clock3 />} title="A little error persists">
              About 5% is slow bias from effects such as calibration, lighting, or road slope. It is intentionally modest.
            </DarkNote>
          </section>

          <FilterExplanation />
          <InputMap />

          <section className="mt-8 border-t border-zinc-700 pt-6">
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

        <div className="sticky bottom-0 flex justify-end border-t border-zinc-700 bg-[#0d1014] px-6 py-3">
          <AlertDialogCancel className="mt-0 border-zinc-600 bg-zinc-900 text-zinc-100 hover:bg-zinc-800">Close</AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FrameSequence() {
  return (
    <section aria-labelledby="frames-heading">
      <div className="max-w-3xl">
        <h2 id="frames-heading" className="text-2xl font-medium tracking-tight sm:text-3xl">
          The car is steady. The measurements are not.
        </h2>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Each dashed box is a fresh camera estimate. The solid blue track follows their shared motion instead of chasing every small jump.
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
    <section className="mt-8 border-y border-zinc-700 py-7">
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
      <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-5 text-zinc-500">
        This repeats every frame. Filtering reduces random jitter without pretending the sensor is exact; persistent bias can remain, and a track is removed if a measurement is missing for more than 420 ms.
      </p>
    </section>
  );
}

function InputMap() {
  return (
    <section className="mt-8">
      <div className="max-w-3xl">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">Data passed to autopilot(input)</div>
        <h2 className="mt-2 text-2xl font-medium">What the two noise settings change</h2>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Both settings change sensor fields before your controller runs. Vehicle data offers both stages; lane data currently offers only the direct detection.
        </p>
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-zinc-700">
        <InputRow
          setting="Noisy vehicle poses"
          field="input.vehicleMeasurements"
          status="Raw · not filtered"
          tone="amber"
        >
          When on, position, rotation, size, confidence, and uncertainty vary with distance, and measurements may briefly disappear. When off, these observations use exact simulated geometry.
        </InputRow>
        <InputRow
          setting="Noisy vehicle poses"
          field="input.vehicles"
          status="Pre-filtered tracks"
          tone="blue"
        >
          Always produced by the built-in constant-velocity tracker. With noise on it smooths measurements and predicts through short dropouts; with noise off it tracks exact observations.
        </InputRow>
        <InputRow
          setting="Noisy lane lines"
          field="input.laneLines"
          status="Raw · not temporally filtered"
          tone="amber"
        >
          When on, individual lane samples jitter, lose confidence, or disappear—especially farther ahead. When off, the samples match the simulated road. No built-in tracker smooths them over time.
        </InputRow>
      </div>
    </section>
  );
}

function FilmFrame({ index, offset, tracked = false }: { index: string; offset: string; tracked?: boolean }) {
  return (
    <figure className="border border-zinc-700 bg-black p-2">
      <div className="relative h-40 overflow-hidden bg-zinc-900">
        <div className="absolute inset-y-0 left-1/2 w-20 -translate-x-1/2 border-x border-zinc-700" />
        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-zinc-600" />
        <div className="absolute left-1/2 top-1/2 flex h-14 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm bg-zinc-300 text-zinc-800"><Car size={15} /></div>
        <div className={`absolute left-1/2 top-1/2 h-16 w-10 -translate-x-1/2 -translate-y-1/2 border-2 border-dashed border-amber-300 ${offset}`} />
        {tracked ? <div className="absolute left-1/2 top-1/2 h-16 w-10 -translate-x-1/2 -translate-y-1/2 border-2 border-sky-400" /> : null}
      </div>
      <figcaption className="flex justify-between pt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
        <span>Frame {index}</span><span>{tracked ? 'track added' : 'raw detection'}</span>
      </figcaption>
    </figure>
  );
}

function DarkNote({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="bg-zinc-900 p-4">
      <div className="flex items-center gap-2 text-amber-200 [&_svg]:h-4 [&_svg]:w-4">{icon}<h3 className="text-sm font-medium text-zinc-100">{title}</h3></div>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{children}</p>
    </section>
  );
}

function FilterStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <section className="border-t-2 border-sky-400 bg-zinc-900 p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-sky-300">Step {number}</div>
      <h3 className="mt-2 text-sm font-medium text-zinc-100">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{children}</p>
    </section>
  );
}

function StepArrow() {
  return <div className="flex items-center justify-center"><ArrowRight className="rotate-90 text-zinc-600 md:rotate-0" size={18} /></div>;
}

function InputRow({ setting, field, status, tone, children }: { setting: string; field: string; status: string; tone: 'amber' | 'blue'; children: ReactNode }) {
  const badge = tone === 'blue' ? 'border-sky-400/30 bg-sky-400/10 text-sky-200' : 'border-amber-300/30 bg-amber-300/10 text-amber-200';
  return (
    <section className="grid gap-3 border-b border-zinc-700 bg-zinc-900 p-4 last:border-b-0 md:grid-cols-[10rem_13rem_1fr] md:items-start">
      <div className="text-xs font-medium text-zinc-300">{setting}</div>
      <div><code className="font-mono text-xs text-zinc-100">{field}</code><div className={`mt-2 inline-flex rounded border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] ${badge}`}>{status}</div></div>
      <p className="text-xs leading-5 text-zinc-400">{children}</p>
    </section>
  );
}

function SettingNote({ name, effect }: { name: string; effect: string }) {
  return <section className="border-l-2 border-zinc-600 pl-3"><h3 className="text-sm font-medium text-zinc-200">{name}</h3><p className="mt-1 text-xs leading-5 text-zinc-500">{effect}</p></section>;
}
