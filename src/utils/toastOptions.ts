import { DefaultToastOptions } from 'react-hot-toast';

export const toastOptions: DefaultToastOptions = {
  duration: 4000,
  style: {
    background: '#363636',
    color: '#fff',
  },
  success: {
    duration: 3000,
    iconTheme: {
      primary: '#4ade80',
      secondary: '#fff',
    },
  },
  error: {
    duration: 5000,
    iconTheme: {
      primary: '#ef4444',
      secondary: '#fff',
    },
  },
};
