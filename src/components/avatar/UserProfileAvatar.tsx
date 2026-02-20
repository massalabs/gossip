import React from 'react';
import { getProfileHead } from './profileHeads';

interface UserProfileAvatarProps {
  name?: string;
  size?: number; // allowed: 8, 10, 12, 14, 16 (maps to w-*/h-*)
  className?: string;
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
 * User profile avatar component using head illustrations.
 * Picks a head deterministically based on the user's name.
 */
const UserProfileAvatar: React.FC<UserProfileAvatarProps> = ({
  name = '',
  size = 10,
  className = '',
}) => {
  const sizeClass = SIZE_CLASS_MAP[size] ?? SIZE_CLASS_MAP[10];
  const paddingClass = PADDING_MAP[size] ?? PADDING_MAP[10];

  return (
    <div
      className={`${sizeClass} ${paddingClass} ${className} shrink-0 rounded-full bg-primary flex items-center justify-center`}
    >
      <img
        src={getProfileHead(name)}
        className="w-full h-full object-contain"
        alt="Profile"
      />
    </div>
  );
};

export default UserProfileAvatar;
