import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#071013',
        panel: '#10181b',
        panelSoft: '#152327',
        mint: '#6df7d1',
        amber: '#f7c86d',
        signal: '#89a9ff',
      },
      boxShadow: {
        glow: '0 0 30px rgba(109, 247, 209, 0.14)',
      },
    },
  },
  plugins: [],
} satisfies Config;
