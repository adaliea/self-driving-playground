import { Check } from 'lucide-react';

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  detail?: string;
}

export function Toggle({ label, checked, onChange, detail }: ToggleProps) {
  return (
    <label className="group flex cursor-pointer items-center justify-between gap-3 rounded-md border border-white/8 bg-white/[0.035] px-3 py-2 transition hover:border-mint/30">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-100">{label}</span>
        {detail ? <span className="mt-0.5 block text-xs text-slate-400">{detail}</span> : null}
      </span>
      <span
        className={`grid h-5 w-9 shrink-0 place-items-center rounded-full border transition ${
          checked ? 'border-mint/70 bg-mint/20' : 'border-white/15 bg-black/30'
        }`}
      >
        <span
          className={`grid h-4 w-4 place-items-center rounded-full transition ${
            checked ? 'translate-x-2 bg-mint text-ink' : '-translate-x-2 bg-slate-500'
          }`}
        >
          {checked ? <Check size={11} strokeWidth={3} /> : null}
        </span>
      </span>
      <input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
