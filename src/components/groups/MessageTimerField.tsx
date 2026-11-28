import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'react-feather';
import OptionBottomSheet from '../ui/OptionBottomSheet';
import {
  MESSAGE_TIMER_OPTIONS,
  messageTimerLabel,
} from '../../constants/messageTimer';

interface MessageTimerFieldProps {
  /** The timer chosen, in milliseconds; 0 keeps messages forever. */
  value: number;
  onChange: (ms: number) => void;
  /** A short line under the label. */
  hint?: string;
  disabled?: boolean;
  testId?: string;
}

/**
 * A row that shows a message timer (§7.7) and opens the list of the values
 * offered. A value outside the list (set by another client) is shown as a
 * plain duration and stays selected until another is chosen.
 */
const MessageTimerField: React.FC<MessageTimerFieldProps> = ({
  value,
  onChange,
  hint,
  disabled,
  testId = 'message-timer-field',
}) => {
  const { t } = useTranslation('groups');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid={testId}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex items-start gap-2 min-w-0">
          <Clock className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block">{t('timer.label')}</span>
            {hint && (
              <span className="block text-xs text-muted-foreground">
                {hint}
              </span>
            )}
          </span>
        </span>
        <span
          className="text-accent-soft-foreground shrink-0"
          data-testid={`${testId}-value`}
        >
          {messageTimerLabel(value, t)}
        </span>
      </button>
      <OptionBottomSheet
        isOpen={open}
        title={t('timer.label')}
        description={t('timer.choose_hint')}
        options={MESSAGE_TIMER_OPTIONS.map(ms => ({
          label: messageTimerLabel(ms, t),
          value: ms,
        }))}
        selectedValue={value}
        onSelect={ms => {
          setOpen(false);
          onChange(ms ?? 0);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
};

export default MessageTimerField;
