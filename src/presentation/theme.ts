import type { CSSProperties } from 'react';
import { CARTOON_FONT } from '../rendering';

/** The presenter screen's cartoon look, shared with /host. */
export const ink = '#1d1b2e';
export const grass = '#7fd35a';
export const sun = '#ffd23f';
export const sky = '#3d8bff';
export const cherry = '#ef233c';
export const mint = '#00c2a8';
export const bubblegum = '#ff7ac6';

export const panel = 'rounded-2xl border-[3px] border-[#1d1b2e] bg-white shadow-[4px_4px_0_#1d1b2e]';

// The deck is light; the rest of the app sets a dark color scheme on :root.
export const deckFontStyle: CSSProperties = { fontFamily: CARTOON_FONT, colorScheme: 'light', color: ink };

/** Mowed-lawn stripes, matching the road renderer's grass. */
export const lawnStyle: CSSProperties = {
  background: `repeating-linear-gradient(90deg, ${grass} 0 40px, #74c851 40px 80px)`,
};
