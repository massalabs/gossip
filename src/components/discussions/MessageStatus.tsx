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
  /**
   * The user submitted this row in the current app session and the SDK
   * has accepted it. Forces the ✓ rendering even if the DB status is
   * still WAITING_SESSION / READY (the SDK keeps that for correctness;
   * the UI commits early — see `optimisticallySentIds` in the message
   * store for rationale and lifecycle).
   */
  isOptimisticallySent?: boolean;
}

const MessageStatusIndicator: React.FC<MessageStatusProps> = React.memo(
  ({
    status,
    timestamp,
    isOutgoing,
    isDeleted,
    isEdited,
    isSending,
    showTimestamp,
    isOptimisticallySent,
  }) => {
    const { t } = useTranslation('discussions');

    if (!showTimestamp && !(!isDeleted && (isOutgoing || isEdited)))
      return null;

    const isDeliveredOrRead =
      status === MessageStatusEnum.DELIVERED ||
      status === MessageStatusEnum.READ;
    const showSent =
      !isDeliveredOrRead &&
      (status === MessageStatusEnum.SENT || isOptimisticallySent);
    const showSending = !isDeliveredOrRead && !showSent && isSending;

    return (
      <span
        className={`inline-flex items-center gap-1 ml-1.5 align-bottom translate-y-[1px] ${
          isOutgoing
            ? 'text-bubble-sent-foreground/80'
            : 'text-muted-foreground'
        }`}
      >
        {isEdited && (
          <span className="text-[10px] italic opacity-75">
            {t('message_item.edited')}
          </span>
        )}
        {showTimestamp && (
          <span className="text-[11px] font-medium">
            {formatTime(timestamp)}
          </span>
        )}
        {isOutgoing && !isDeleted && (
          <span
            className="inline-flex items-center w-4 h-3.5 transition-opacity duration-200"
            aria-label={t('message_item.status', { status })}
          >
            {showSending && (
              <Clock
                className="w-3 h-3"
                aria-label={t('message_item.sending')}
              />
            )}
            {showSent && (
              <CheckIcon
                className="w-3.5 h-3.5"
                aria-label={t('message_item.sent')}
              />
            )}
            {isDeliveredOrRead && (
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
  }
);

MessageStatusIndicator.displayName = 'MessageStatusIndicator';

export default MessageStatusIndicator;
