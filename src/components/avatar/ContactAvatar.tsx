import React from 'react';
import { Contact } from '@massalabs/gossip-sdk';
import { getAvatarSurfaceClass } from './avatarIdentity';
import { getProfileHead } from './profileHeads';

interface ContactAvatarProps {
  /** `userId` is used for the ring color when present (stable identity); falls back to `name`. */
  contact: Pick<Contact, 'name' | 'avatar' | 'userId'>;
  size?: number; // allowed: 8, 10, 12, 14, 16 (maps to w-*/h-*)
}

const SIZE_CLASS_MAP: Record<number, string> = {
  8: 'w-8 h-8',
  10: 'w-10 h-10',
  12: 'w-12 h-12',
  14: 'w-14 h-14',
  16: 'w-16 h-16',
};

const PADDING_MAP: Record<number, string> = {
  8: 'p-1',
  10: 'p-1.5',
  12: 'p-2',
  14: 'p-2',
  16: 'p-2.5',
};

/**
 * Contact avatar: same deterministic head illustrations as the user profile (`getProfileHead`).
 * `contact.avatar` is ignored — assets are bundled and preloaded in `profileHeads.ts`.
 */
const ContactAvatar: React.FC<ContactAvatarProps> = ({
  contact,
  size = 10,
}) => {
  const sizeClass = SIZE_CLASS_MAP[size] ?? SIZE_CLASS_MAP[10];
  const paddingClass = PADDING_MAP[size] ?? PADDING_MAP[10];
  const surfaceClass = getAvatarSurfaceClass(
    contact.userId?.trim() || contact.name
  );

  return (
    <div
      className={`${sizeClass} ${paddingClass} shrink-0 rounded-full border border-border ${surfaceClass} flex items-center justify-center`}
    >
      <img
        src={getProfileHead(contact.name)}
        className="w-full h-full object-contain"
        alt={contact.name}
      />
    </div>
  );
};

export default ContactAvatar;
