import { DefaultToastOptions } from 'react-hot-toast';

export const toastOptions: DefaultToastOptions = {
  duration: 4000,
  style: {
    background: 'var(--card)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
  },
  success: {
    duration: 3000,
    iconTheme: {
      primary: 'var(--success)',
      secondary: 'var(--card)',
    },
  },
  error: {
    duration: 5000,
    iconTheme: {
      primary: 'var(--destructive)',
      secondary: 'var(--card)',
    },
  },
};
