/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        bc: {
          black:      '#0a0a0a',
          dark:       '#111111',
          card:       '#1a1a1a',
          border:     '#2a2a2a',
          muted:      '#666666',
          text:       '#e0e0e0',
          white:      '#f5f5f5',
          gold:       '#c9a84c',
          'gold-dim': '#8a6f2e',
        },
      },
      fontFamily: {
        display: ['"DM Serif Display"', 'serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        sans:    ['"DM Sans"', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
