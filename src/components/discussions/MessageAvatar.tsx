import React from 'react';
import ContactAvatar from '../avatar/ContactAvatar';
import type { Contact } from '@massalabs/gossip-sdk';

interface MessageAvatarProps {
  contact: Pick<Contact, 'name' | 'avatar' | 'userId'>;
  showAvatar: boolean;
}

const MessageAvatar: React.FC<MessageAvatarProps> = React.memo(
  ({ contact, showAvatar }) => (
    <div className="w-8 shrink-0 ml-1">
      {showAvatar ? (
        <ContactAvatar contact={contact} size={8} />
      ) : (
        <div className="w-8 h-8" />
      )}
    </div>
  )
);

MessageAvatar.displayName = 'MessageAvatar';

export default MessageAvatar;
