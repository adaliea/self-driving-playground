import { useId, type ReactNode } from 'react';

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  detail?: string;
  /** Rendered beside the label, e.g. a help button. */
  accessory?: ReactNode;
}

export function Toggle({ label, checked, onChange, detail, accessory }: ToggleProps) {
  // Explicit `for` keeps the label tied to the checkbox; otherwise a button accessory would become the labeled control.
  const inputId = useId();
  return (
    <label htmlFor={inputId} className="flex min-h-8 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 transition-colors hover:bg-accent focus-within:ring-1 focus-within:ring-ring">
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm text-foreground">
          {label}
          {accessory}
        </span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <span
        className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-signal' : 'bg-input'
        }`}
      >
        <span
          className={`block h-3 w-3 rounded-full transition-transform ${
            checked ? 'translate-x-3.5 bg-signal-foreground' : 'translate-x-0.5 bg-muted-foreground'
          }`}
        />
      </span>
      <input id={inputId} className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
