const { hairlineWidth } = require('nativewind/theme');

/** Lyra geometry + shared semantic color variables. */
module.exports = {
  darkMode: 'class',
  content: ['./App.tsx', './components/**/*.{ts,tsx}', './screens/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        border: 'var(--border)', input: 'var(--input)', ring: 'var(--ring)',
        background: 'var(--background)', foreground: 'var(--foreground)',
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
      },
      borderRadius: { lg: '0px', md: '0px', sm: '0px', none: '0px' },
      borderWidth: { hairline: hairlineWidth() },
      fontFamily: { sans: ['monospace'], mono: ['monospace'] },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
