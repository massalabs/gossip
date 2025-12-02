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

export const CopyIcon: React.FC<IconProps> = ({ className = '' }) => (
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

export const CloseIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-6 h-6 ${className}`.trim()}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M6 18L18 6M6 6l12 12"
    />
  </svg>
);

export const UploadIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={`w-5 h-5 ${className}`.trim()}
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
    />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ className = '' }) => (
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
      d="M5 13l4 4L19 7"
    />
  </svg>
);

export const DownloadIcon: React.FC<IconProps> = ({ className = '' }) => (
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
      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
    />
  </svg>
);

export const EditIcon: React.FC<IconProps> = ({ className = '' }) => (
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
      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
    />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ className = '' }) => (
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
      d="M12 4v16m8-8H4"
    />
  </svg>
);

export const IOSIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="currentColor"
    viewBox="0 0 24 24"
    className={className || 'w-5 h-5'}
  >
    <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C1.79 15.25 4.54 7.08 9.5 6.9c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 6.9c-.15-2.58 2.14-4.77 4.78-5.04.42 3.14-2.73 5.78-4.78 5.04z" />
  </svg>
);

export const AndroidIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="currentColor"
    viewBox="0 0 24 24"
    className={className || 'w-5 h-5'}
  >
    <path d="M17.523 15.3414c-.5511 0-.9993-.4486-.9993-.9997 0-.5511.4482-.9993.9993-.9993.5511 0 .9993.4482.9993.9993 0 .5511-.4482.9997-.9993.9997m-11.046 0c-.5511 0-.9993-.4486-.9993-.9997 0-.5511.4482-.9993.9993-.9993.551 0 .9993.4482.9993.9993 0 .5511-.4483.9997-.9993.9997m11.4045-6.02l1.9973-3.4592a.416.416 0 00-.1521-.5676.416.416 0 00-.5676.1521l-2.0223 3.503C15.5902 8.2439 13.8533 7.8508 12 7.8508s-3.5902.3931-5.1349 1.0857L4.8429 5.4336a.4161.4161 0 00-.5676-.1521.4157.4157 0 00-.1521.5676l1.9973 3.4592C2.6889 11.186.8535 13.7177.8535 16.7402v.4157h22.293v-.4157c0-3.0225-1.8354-5.5535-4.2675-6.4188" />
  </svg>
);

export const GitHubIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="currentColor"
    viewBox="0 0 24 24"
    className={className || 'w-5 h-5'}
  >
    <path
      fillRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.197 22 16.425 22 12.017 22 6.484 17.522 2 12 2z"
      clipRule="evenodd"
    />
  </svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({ className = '' }) => (
  <svg
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    className={className || 'w-5 h-5'}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 5l7 7-7 7"
    />
  </svg>
);
