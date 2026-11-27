import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Info } from 'react-feather';
import Toggle from '../ui/Toggle';
import { USERNAME_MAX_LENGTH } from '../../utils/validation';

interface ContactRequestFieldsProps {
  shareUsername: boolean;
  onShareUsernameChange: (value: boolean) => void;
  customUsername: string;
  onCustomUsernameChange: (value: string) => void;
  customUsernameError?: string;
  message: string;
  onMessageChange: (value: string) => void;
  showMessage: boolean;
  onShowMessageChange: (value: boolean) => void;
  /** Shown in the empty message box. */
  placeholder: string;
  className?: string;
}

/**
 * What a contact request may carry, chosen by the user: their username, and
 * a short message (§5.12). The same fields for a first request and for a
 * request sent again to a contact whose connection lapsed, which is the same
 * request on the wire.
 */
const ContactRequestFields: React.FC<ContactRequestFieldsProps> = ({
  shareUsername,
  onShareUsernameChange,
  customUsername,
  onCustomUsernameChange,
  customUsernameError,
  message,
  onMessageChange,
  showMessage,
  onShowMessageChange,
  placeholder,
  className = 'mb-6',
}) => {
  const { t } = useTranslation('contacts');
  return (
    <div
      className={`bg-card rounded-xl border border-border overflow-hidden ${className}`}
    >
      {/* Share username */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm text-foreground">
          {t('new_contact.share_username')}
        </span>
        <Toggle
          checked={shareUsername}
          onChange={onShareUsernameChange}
          ariaLabel={t('new_contact.share_username')}
        />
      </div>
      {shareUsername && (
        <div className="px-4 pb-3">
          <input
            type="text"
            value={customUsername}
            onChange={e => onCustomUsernameChange(e.target.value)}
            placeholder={t('new_contact.share_username_placeholder')}
            className="w-full bg-muted/50 text-foreground placeholder-muted-foreground focus:outline-none rounded-lg px-3 py-2 text-sm"
            aria-label={t('new_contact.share_username_aria')}
            maxLength={USERNAME_MAX_LENGTH}
          />
          {customUsernameError && (
            <p className="mt-1.5 text-sm text-destructive" role="alert">
              {customUsernameError}
            </p>
          )}
        </div>
      )}

      {/* Custom message */}
      <div className="border-t border-border">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-foreground">
            {t('new_contact.announcement_label')}
          </span>
          <Toggle
            checked={message.length > 0 || showMessage}
            onChange={v => {
              onShowMessageChange(v);
              if (!v) onMessageChange('');
            }}
            ariaLabel={t('new_contact.announcement_label')}
          />
        </div>
        {(showMessage || message.length > 0) && (
          <div className="px-4 pb-3">
            <textarea
              id="contact-message"
              value={message}
              onChange={e => onMessageChange(e.target.value)}
              placeholder={placeholder}
              rows={3}
              maxLength={500}
              className="w-full bg-muted/50 text-foreground placeholder-muted-foreground focus:outline-none resize-none text-sm rounded-lg px-3 py-2"
              aria-label={t('new_contact.announcement_aria')}
            />
            {message && (
              <div className="flex items-center justify-end mt-1">
                <span className="text-xs text-muted-foreground">
                  {message.length}/500
                </span>
              </div>
            )}
            <div className="flex items-start gap-2 mt-2 bg-muted/30 rounded-lg p-2.5">
              <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <Trans
                  i18nKey="privacy_notice.body"
                  ns="contacts"
                  components={{ strong: <strong /> }}
                />
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ContactRequestFields;
