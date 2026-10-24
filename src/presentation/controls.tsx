import type { ReactNode } from 'react';
import { ink, mint } from './theme';

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      {children}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-7 w-12 shrink-0 rounded-full border-[3px] border-[#1d1b2e] transition-colors"
        style={{ background: checked ? mint : '#e5e1d6' }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full border-2 border-[#1d1b2e] bg-white transition-[left]"
          style={{ left: checked ? '1.5rem' : '0.15rem' }}
        />
      </button>
    </label>
  );
}

export function DeckButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border-[3px] border-[#1d1b2e] bg-white px-3 py-2 text-base font-black shadow-[3px_3px_0_#1d1b2e] transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
      style={{ color: ink }}
    >
      {children}
    </button>
  );
}
