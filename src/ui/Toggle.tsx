interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  detail?: string;
}

export function Toggle({ label, checked, onChange, detail }: ToggleProps) {
  return (
    <label className="group flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 transition hover:bg-accent focus-within:ring-1 focus-within:ring-ring">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-card-foreground">{label}</span>
        {detail ? <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <span
        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
          checked ? 'border-primary bg-primary' : 'border-transparent bg-input'
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full shadow-sm transition-transform ${
            checked ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0.5 bg-background'
          }`}
        />
      </span>
      <input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
