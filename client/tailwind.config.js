/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand palette — a deep industrial navy for the primary and a
        // safety-orange accent. Every tone is defined here once; swap the
        // values to re-brand and nothing else needs to change.
        brand: {
          50: '#eef4fb',
          100: '#d9e6f5',
          200: '#b3ccea',
          300: '#7fa8d9',
          400: '#4a80c4',
          500: '#245fa8',
          600: '#164a8a',
          700: '#113a6e',
          800: '#0d2c54',
          900: '#0a2142',
          950: '#06152b',
        },
        accent: {
          50: '#fff4ec',
          100: '#ffe4d1',
          200: '#ffc7a3',
          300: '#ffa168',
          400: '#ff7a2e',
          500: '#f45f0c',
          600: '#d94d03',
          700: '#b03c05',
          800: '#8c300c',
          900: '#712a0e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(10,33,66,0.06), 0 1px 3px rgba(10,33,66,0.08)',
        hover: '0 10px 30px -10px rgba(10,33,66,0.25), 0 4px 10px -4px rgba(10,33,66,0.12)',
        lift: '0 18px 40px -12px rgba(10,33,66,0.35)',
        glow: '0 0 0 1px rgba(36,95,168,0.25), 0 8px 24px -8px rgba(36,95,168,0.45)',
        inset: 'inset 0 1px 2px rgba(10,33,66,0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(.96) translateY(6px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'slide-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'page-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'drop-in': {
          from: { opacity: '0', transform: 'translateY(-6px) scale(.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pop': {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.12)' },
          '100%': { transform: 'scale(1)' },
        },
        shimmer: {
          from: { backgroundPosition: '-200% 0' },
          to: { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in .18s ease-out',
        'scale-in': 'scale-in .18s cubic-bezier(.16,1,.3,1)',
        'slide-up': 'slide-up .24s cubic-bezier(.16,1,.3,1)',
        'page-in': 'page-in .28s cubic-bezier(.16,1,.3,1)',
        'drop-in': 'drop-in .16s cubic-bezier(.16,1,.3,1)',
        pop: 'pop .28s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
