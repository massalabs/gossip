import React from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'react-feather';

/**
 * "Deletes after <duration>" with a clock, as a conversation header shows
 * it: the retention of an earlier one-to-one conversation, or the message
 * timer of a group chat (§7.7).
 */
const AutoDeleteChip: React.FC<{ duration: string; testId?: string }> = ({
  duration,
  testId,
}) => {
  const { t } = useTranslation('discussions');
  return (
    <span
      className="inline-flex items-center gap-1.5 min-w-0 flex-1 text-xs text-muted-foreground overflow-hidden"
      data-testid={testId}
    >
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span className="leading-snug truncate">
        {t('header.auto_delete_active', { duration })}
      </span>
    </span>
  );
};

export default AutoDeleteChip;
