import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RadioRelayRecord } from '@massalabs/gossip-sdk';
import { formatTime } from '../../utils/timeUtils';
import SafeName from './SafeName';

interface RadioRelayItemProps {
  relay: RadioRelayRecord;
  isOutgoing: boolean;
  authorName: string;
}

/**
 * A temporary copy of a group message, heard on the radio while this device
 * had no internet: shown until the message itself arrives, which replaces it.
 * Text only, possibly cut, and with no menu: there is nothing to act on yet.
 */
const RadioRelayItem: React.FC<RadioRelayItemProps> = ({
  relay,
  isOutgoing,
  authorName,
}) => {
  const { t } = useTranslation('groups');
  return (
    <div
      className={`flex flex-col max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] my-1 ${
        isOutgoing ? 'ml-auto mr-3' : 'ml-3 mr-auto'
      }`}
      data-testid="radio-relay"
    >
      {!isOutgoing && (
        <p className="px-1 pb-0.5 text-xs font-medium text-muted-foreground">
          <SafeName name={authorName} />
        </p>
      )}
      <div
        className={`px-3.5 py-3 text-[15px] leading-tight rounded-2xl border border-dashed ${
          isOutgoing
            ? 'bg-bubble-sent/70 text-bubble-sent-foreground border-bubble-sent-foreground/30'
            : 'bg-bubble-received/70 text-bubble-received-foreground border-border'
        }`}
      >
        <p className="whitespace-pre-wrap wrap-break-word">
          {relay.text}
          {relay.truncated ? '…' : ''}
        </p>
        {relay.olderKey && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            {t('radio.older_key_warning')}
          </p>
        )}
        <p className="mt-1 text-[11px] opacity-70 text-right">
          <span className="mr-1" data-testid="radio-relay-marker">
            {relay.truncated ? t('radio.relayed_cut') : t('radio.relayed')}
          </span>
          {formatTime(new Date(relay.createdAt))}
        </p>
      </div>
    </div>
  );
};

export default RadioRelayItem;
