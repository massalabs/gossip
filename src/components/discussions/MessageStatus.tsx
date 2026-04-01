import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check as CheckIcon, Clock } from 'react-feather';
import { MessageStatus as MessageStatusEnum } from '@massalabs/gossip-sdk';
import { formatTime } from '../../utils/timeUtils';

interface MessageStatusProps {
  status: string;
  timestamp: Date;
  isOutgoing: boolean;
  isDeleted: boolean;
  isEdited: boolean;
  isSending: boolean;
  showTimestamp: boolean;
}

const MessageStatusIndicator: React.FC<MessageStatusProps> = ({
  status,
  timestamp,
  isOutgoing,
  isDeleted,
  isEdited,
  isSending,
  showTimestamp,
}) => {
  const { t } = useTranslation('discussions');

  if (!showTimestamp && !(!isDeleted && (isOutgoing || isEdited))) return null;

  return (
    <span
      className={`absolute bottom-[13px] right-2.5 flex items-center gap-1 ${
        isOutgoing ? 'text-accent-foreground/80' : 'text-muted-foreground'
      }`}
    >
      {isEdited && !isSending && (
        <span className="text-[10px] italic opacity-75">
          {t('message_item.edited')}
        </span>
      )}
      {showTimestamp && !isSending && (
        <span className="text-[11px] font-medium">{formatTime(timestamp)}</span>
      )}
      {isOutgoing && !isDeleted && (
        <span
          className="inline-flex items-center w-4 h-3.5 transition-opacity duration-200"
          aria-label={t('message_item.status', { status })}
        >
          {isSending && (
            <Clock className="w-3 h-3" aria-label={t('message_item.sending')} />
          )}
          {status === MessageStatusEnum.SENT && (
            <CheckIcon
              className="w-3.5 h-3.5"
              aria-label={t('message_item.sent')}
            />
          )}
          {(status === MessageStatusEnum.DELIVERED ||
            status === MessageStatusEnum.READ) && (
            <span
              className="relative inline-flex items-center w-4 h-3.5"
              aria-label={t('message_item.delivered')}
            >
              <CheckIcon className="w-3.5 h-3.5 absolute left-0" />
              <CheckIcon className="w-3.5 h-3.5 absolute left-[5px] top-[1.5px]" />
            </span>
          )}
        </span>
      )}
    </span>
  );
};

export default MessageStatusIndicator;
