import React from 'react';

interface IconProps {
  className?: string;
}

export const WalletIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-full h-full ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

export const DiscussionsIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-full h-full ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

export const SettingsIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-full h-full ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);

export const DangerIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

export const AccountBackupIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
    />
  </svg>
);

export const ShareContactIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 8a3 3 0 11-6 0 3 3 0 016 0zm-9 9a6 6 0 1112 0H6z"
    />
  </svg>
);

export const SecurityIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
    />
  </svg>
);

export const NotificationsIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
    />
  </svg>
);

export const PrivacyIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
    />
  </svg>
);

export const DarkModeIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
    />
  </svg>
);

export const LightModeIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
    />
  </svg>
);

export const DebugIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
    />
  </svg>
);

export const RefreshIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

export const LogoutIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
    />
  </svg>
);

export const DeleteIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
    />
  </svg>
);

export const CameraIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);
