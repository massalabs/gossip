import React from 'react';
import { Message, MessageDirection, MessageStatus } from '../../db';
import { formatTime } from '../../utils/timeUtils';

interface MessageItemProps {
  message: Message;
}

const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const isOutgoing = message.direction === MessageDirection.OUTGOING;

  return (
    <div
      className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'} group`}
    >
      {/* TODO: Add on group chat */}
      {/* {!isOutgoing && (
          <div className="w-6 h-8 shrink-0 mb-1 opacity-0 opacity-100 transition-opacity">
            {showAvatar && <ContactAvatar contact={contact} size={8} />}
          </div>
        )} */}
      <div
        className={`relative max-w-[78%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] px-4 py-3 rounded-2xl font-medium text-[15px] leading-tight animate-bubble-in ${
          isOutgoing
            ? 'ml-auto mr-3 bg-accent text-accent-foreground rounded-br-[6px]'
            : 'ml-3 mr-auto bg-card text-card-foreground rounded-bl-[6px] shadow-sm'
        }`}
      >
        {/* Message */}
        <p className="whitespace-pre-wrap wrap-break-word pr-6">
          {message.content}
        </p>

        {/* Timestamp and Status */}
        <div
          className={`flex items-center justify-end gap-1.5 mt-1.5 ${
            isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground'
          }`}
        >
          <span className="text-[11px] font-medium">
            {formatTime(message.timestamp)}
          </span>
          {isOutgoing && (
            <div className="flex items-center gap-1">
              {message.status === MessageStatus.SENDING && (
                <div className="flex items-center gap-1">
                  <div className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-[10px] font-medium">Sending</span>
                </div>
              )}
              {message.status === MessageStatus.SENT && (
                <svg
                  className="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              {message.status === MessageStatus.FAILED && (
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3.5 h-3.5 text-accent-foreground/90"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] font-medium">Failed</span>
                </div>
              )}
              {(message.status === MessageStatus.DELIVERED ||
                message.status === MessageStatus.READ) && (
                <svg
                  className="w-3.5 h-3.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
          )}
        </div>

        {/* Tail - Sent (right side) */}
        {isOutgoing && (
          <>
            {/* Border layer (slightly larger, behind) */}
            <div
              className="absolute bottom-0 right-2 w-0 h-0"
              style={{
                borderLeft: '13px solid transparent',
                borderTop: '13px solid var(--tail-border)',
                marginBottom: '-13px',
                zIndex: 0,
              }}
            />
            {/* Fill layer (slightly smaller, in front) */}
            <div
              className="absolute bottom-0 right-2 w-0 h-0"
              style={{
                borderLeft: '12px solid transparent',
                borderTop: '12px solid var(--accent)',
                marginBottom: '-12px',
                zIndex: 1,
              }}
            />
          </>
        )}

        {/* Tail - Received (left side) */}
        {!isOutgoing && (
          <>
            {/* Border layer (slightly larger, behind) */}
            <div
              className="absolute bottom-0 left-2 w-0 h-0"
              style={{
                borderRight: '13px solid transparent',
                borderTop: '13px solid var(--tail-border)',
                marginBottom: '-13px',
                zIndex: 0,
              }}
            />
            {/* Fill layer (slightly smaller, in front) */}
            <div
              className="absolute bottom-0 left-2 w-0 h-0"
              style={{
                borderRight: '12px solid transparent',
                borderTop: '12px solid var(--card)',
                marginBottom: '-12px',
                zIndex: 1,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default MessageItem;
