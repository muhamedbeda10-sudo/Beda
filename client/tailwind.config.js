import colors from 'tailwindcss/colors'

// ============================================================================
// Design tokens. Spacing is Tailwind's 4 px scale. Type runs 12/13/14/16/20/24
// (xs, 13, sm, base, xl, 2xl). Radius runs 6/8/12 (md, lg, xl; 2xl and 3xl
// are folded into 12 so every card and dialog shares one corner). Colour is
// named by meaning — success, warning, danger, info, neutral — and secondary
// text is `muted`, which keeps WCAG AA contrast in both themes.
// ============================================================================

// The LinkMisr blue of the logo: the brand, and the colour of information.
const brand = {
  50: '#eef3fc',
  100: '#d9e4f9',
  200: '#b4c8f2',
  300: '#85a4e8',
  400: '#5479d8',
  500: '#3357c2',
  600: '#1e46a8',
  700: '#193a8a',
  800: '#162f6d',
  900: '#12275a',
  950: '#0b1839',
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontSize: {
        13: ['13px', { lineHeight: '18px' }],
      },
      borderRadius: {
        '2xl': '12px',
        '3xl': '12px',
      },
      colors: {
        // Secondary text: slate-500 on light surfaces, slate-400 on dark ones (index.css).
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        success: colors.emerald,
        warning: colors.amber,
        danger: colors.rose,
        info: brand,
        neutral: colors.slate,
        // Brand palette, taken from the LinkMisr logo: the royal blue of
        // "LINK" and the red of "MISR". Every tone is defined here once.
        brand,
        accent: {
          50: '#fdecec',
          100: '#fbd5d6',
          200: '#f6a9ab',
          300: '#ef7276',
          400: '#e84a50',
          500: '#e3202a',
          600: '#c4161f',
          700: '#a2131a',
          800: '#841418',
          900: '#6e1418',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(18,39,90,0.06), 0 1px 3px rgba(18,39,90,0.08)',
        hover: '0 10px 30px -10px rgba(18,39,90,0.25), 0 4px 10px -4px rgba(18,39,90,0.12)',
        lift: '0 18px 40px -12px rgba(18,39,90,0.35)',
        glow: '0 0 0 1px rgba(30,70,168,0.25), 0 8px 24px -8px rgba(30,70,168,0.45)',
        inset: 'inset 0 1px 2px rgba(18,39,90,0.08)',
      },
      keyframes: {
        wiggle: { '0%, 100%': { transform: 'rotate(0deg)' }, '20%, 60%': { transform: 'rotate(-14deg)' }, '40%, 80%': { transform: 'rotate(14deg)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(.96) translateY(6px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'slide-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '.4', transform: 'translateX(48px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'grow-x': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
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
        'slide-in-right': 'slide-in-right .32s cubic-bezier(.16,1,.3,1)',
        'grow-x': 'grow-x .8s cubic-bezier(.16,1,.3,1) both',
        'page-in': 'page-in .28s cubic-bezier(.16,1,.3,1)',
        'drop-in': 'drop-in .16s cubic-bezier(.16,1,.3,1)',
        pop: 'pop .28s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
