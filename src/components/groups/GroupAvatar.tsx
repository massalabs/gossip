import React from 'react';
import { Users } from 'react-feather';
import ContactAvatar from '../avatar/ContactAvatar';

interface GroupAvatarProps {
  /** The members of the chat, the user included. */
  members: string[];
  me?: string;
  memberName: (userId: string) => string;
}

/**
 * The avatar of a chat in the lists (Lucas's screens 03 and 14): the other
 * person's avatar in a chat of two, two members' avatars one over the other
 * in a larger chat, a plain icon when nobody else is left.
 */
const GroupAvatar: React.FC<GroupAvatarProps> = ({
  members,
  me,
  memberName,
}) => {
  const others = members.filter(m => m !== me);
  const avatarOf = (userId: string, size: number) => (
    <ContactAvatar
      contact={{ userId, name: memberName(userId), avatar: null }}
      size={size}
    />
  );
  if (others.length === 0) {
    return (
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center shrink-0">
        <Users className="w-6 h-6 text-foreground" />
      </div>
    );
  }
  if (others.length === 1) return avatarOf(others[0], 12);
  return (
    <div className="relative w-12 h-12 shrink-0" data-testid="group-avatar">
      <div className="absolute top-0 left-0">{avatarOf(others[0], 8)}</div>
      <div className="absolute bottom-0 right-0 rounded-full ring-2 ring-card">
        {avatarOf(others[1], 8)}
      </div>
    </div>
  );
};

export default GroupAvatar;
