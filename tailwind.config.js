/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Colors - using CSS variables for theming
      colors: {
        background: 'var(--color-background)',
        foreground: 'var(--color-foreground)',
        card: {
          DEFAULT: 'var(--color-card)',
          foreground: 'var(--color-card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--color-popover)',
          foreground: 'var(--color-popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--color-primary)',
          foreground: 'var(--color-primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--color-secondary)',
          foreground: 'var(--color-secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--color-muted)',
          foreground: 'var(--color-muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          foreground: 'var(--color-accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--color-destructive)',
          foreground: 'var(--color-destructive-foreground)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
          foreground: 'var(--color-success-foreground)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          foreground: 'var(--color-warning-foreground)',
        },
        border: 'var(--color-border)',
        input: 'var(--color-input)',
        ring: 'var(--color-ring)',
        chart: {
          1: 'var(--color-chart-1)',
          2: 'var(--color-chart-2)',
          3: 'var(--color-chart-3)',
          4: 'var(--color-chart-4)',
          5: 'var(--color-chart-5)',
        },
        sidebar: {
          DEFAULT: 'var(--color-sidebar)',
          foreground: 'var(--color-sidebar-foreground)',
          primary: 'var(--color-sidebar-primary)',
          'primary-foreground': 'var(--color-sidebar-primary-foreground)',
          accent: 'var(--color-sidebar-accent)',
          'accent-foreground': 'var(--color-sidebar-accent-foreground)',
          border: 'var(--color-sidebar-border)',
          ring: 'var(--color-sidebar-ring)',
        },
      },

      // Border radius
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },

      // Font family
      fontFamily: {
        sans: [
          'Inter',
          'Inter Fallback',
          'system-ui',
          'Avenir',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },

      // ============================================
      // SAFE AREA & LAYOUT SYSTEM
      // ============================================
      spacing: {
        'safe-t': 'var(--sat)',
        'safe-b': 'var(--sab)',
        'safe-l': 'var(--sal)',
        'safe-r': 'var(--sar)',
        // Composites utiles
        header: 'var(--header-height, 3.5rem)',
        'bottom-nav': 'var(--bottom-nav-height, 4rem)',
        // Header + safe area
        'header-safe': 'calc(var(--sat) + var(--header-height, 3.5rem))',
        // Bottom nav + safe area
        'nav-safe': 'calc(var(--sab) + var(--bottom-nav-height, 4rem))',
        // Padding pour header et bottom nav
        'header-padding': 'var(--header-padding, 1.5rem)',
        'nav-padding': 'var(--nav-padding, 1.5rem)',
      },

      // Pour top/bottom/left/right (fixed positioning)
      inset: {
        'safe-t': 'var(--sat)',
        'safe-b': 'var(--sab)',
        'safe-l': 'var(--sal)',
        'safe-r': 'var(--sar)',
      },

      // Pour min-height, height
      height: {
        'safe-t': 'var(--sat)',
        'safe-b': 'var(--sab)',
        // Hauteur écran moins les safe areas
        'screen-safe': 'calc(100dvh - var(--sat) - var(--sab))',
        'bottom-nav': 'var(--bottom-nav-height, 4rem)',
        header: 'var(--header-height, 3.5rem)',
      },

      minHeight: {
        'screen-safe': 'calc(100dvh - var(--sat) - var(--sab))',
      },

      maxHeight: {
        'screen-safe': 'calc(100dvh - var(--sat) - var(--sab))',
      },

      // ============================================
      // ANIMATIONS (inchangé)
      // ============================================
      keyframes: {
        'spin-reverse': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(-360deg)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(-10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'pulse-slow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-20px)' },
        },
        'float-loading': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-15px)' },
        },
        tilt: {
          '0%, 100%': { transform: 'rotate(-3deg)' },
          '50%': { transform: 'rotate(3deg)' },
        },
        'tilt-loading': {
          '0%, 100%': { transform: 'rotate(-5deg)' },
          '50%': { transform: 'rotate(5deg)' },
        },
        blink: {
          '0%, 90%, 100%': { transform: 'scaleY(1)' },
          '95%': { transform: 'scaleY(0.1)' },
        },
        'blink-loading': {
          '0%, 85%, 100%': { transform: 'scaleY(1)' },
          '92.5%': { transform: 'scaleY(0.1)' },
        },
        'pulse-loading': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
        },
        'bubble-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.96)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        'highlight-message': {
          '0%': { backgroundColor: 'transparent' },
          '50%': {
            backgroundColor:
              'color-mix(in oklch, var(--ring) 20%, transparent)',
          },
          '100%': { backgroundColor: 'transparent' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-out-right': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'spin-reverse': 'spin-reverse 1s linear infinite',
        'fade-in': 'fade-in 0.6s ease-out',
        'fade-in-up': 'fade-in-up 0.3s ease-out',
        'spin-slow': 'spin-slow 20s linear infinite',
        'pulse-slow': 'pulse-slow 3s ease-in-out infinite',
        'pulse-loading': 'pulse-loading 2s ease-in-out infinite',
        float: 'float 4s ease-in-out infinite',
        'float-loading': 'float-loading 2.5s ease-in-out infinite',
        tilt: 'tilt 6s ease-in-out infinite',
        'tilt-loading': 'tilt-loading 3s ease-in-out infinite',
        blink: 'blink 4s ease-in-out infinite',
        'blink-loading': 'blink-loading 2s ease-in-out infinite',
        'bubble-in': 'bubble-in 0.22s ease-out',
        'fade-out': 'fade-out 0.3s ease-out',
        'highlight-message': 'highlight-message 2s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'slide-out-right': 'slide-out-right 0.3s ease-out',
      },
    },
  },
  plugins: [],
};
