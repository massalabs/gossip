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

  return (
    <div
      className={`${sizeClass} rounded-full bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-200 flex items-center justify-center text-sm font-semibold aspect-square shrink-0`}
    >
      {initials}
    </div>
  );
};

export default ContactAvatar;
