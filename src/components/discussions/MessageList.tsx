import React from 'react';
import { Message, Discussion } from '../../db';
import VirtualizedMessageList from './VirtualizedMessageList';

interface MessageListProps {
  messages: Message[];
  discussion?: Discussion | null;
  isLoading: boolean;
  onReplyTo?: (message: Message) => void;
}

/**
 * Backwards-compatible wrapper that delegates to the virtualized implementation.
 * Kept to avoid breaking other imports that may still use MessageList.
 */
const MessageList: React.FC<MessageListProps> = props => {
  return <VirtualizedMessageList {...props} />;
};

export default MessageList;
