import React from 'react';
import { Contact } from '@massalabs/gossip-sdk';

interface ContactAvatarProps {
  contact: Pick<Contact, 'name' | 'avatar'>;
  size?: number; // allowed: 8, 10, 12, 14, 16 (maps to w-*/h-*)
}

const SIZE_CLASS_MAP: Record<number, string> = {
  8: 'w-8 h-8',
  10: 'w-10 h-10',
  12: 'w-12 h-12',
  14: 'w-14 h-14',
  16: 'w-16 h-16',
};

const AVATAR_COLORS: [string, string][] = [
  ['bg-rose-100 dark:bg-rose-900', 'text-rose-700 dark:text-rose-200'],
  ['bg-blue-100 dark:bg-blue-900', 'text-blue-700 dark:text-blue-200'],
  ['bg-amber-100 dark:bg-amber-900', 'text-amber-700 dark:text-amber-200'],
  [
    'bg-emerald-100 dark:bg-emerald-900',
    'text-emerald-700 dark:text-emerald-200',
  ],
  ['bg-violet-100 dark:bg-violet-900', 'text-violet-700 dark:text-violet-200'],
  ['bg-cyan-100 dark:bg-cyan-900', 'text-cyan-700 dark:text-cyan-200'],
  [
    'bg-fuchsia-100 dark:bg-fuchsia-900',
    'text-fuchsia-700 dark:text-fuchsia-200',
  ],
  ['bg-teal-100 dark:bg-teal-900', 'text-teal-700 dark:text-teal-200'],
];

function hashName(name: string): number {
  let sum = 0;
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i);
  }
  return sum % AVATAR_COLORS.length;
}

const ContactAvatar: React.FC<ContactAvatarProps> = ({
  contact,
  size = 10,
}) => {
  const sizeClass = SIZE_CLASS_MAP[size] ?? SIZE_CLASS_MAP[10];

  if (contact.avatar) {
    return (
      <img
        src={contact.avatar}
        alt={contact.name}
        className={`${sizeClass} rounded-full object-cover aspect-square shrink-0`}
      />
    );
  }

  const initials = contact.name
    .split(' ')
    .map(s => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const colorIndex = hashName(contact.name);
  const [bgClass, textClass] = AVATAR_COLORS[colorIndex];

  return (
    <div
      className={`${sizeClass} rounded-full ${bgClass} ${textClass} flex items-center justify-center text-sm font-semibold aspect-square shrink-0`}
    >
      {initials}
    </div>
  );
};

export default ContactAvatar;
