/**
 * Explains that Gossip does not use server push: background delivery is best-effort
 * and depends on the OS. Shown on the notifications settings screen for all platforms.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'react-feather';

const BackgroundSyncPrivacyNotice: React.FC = () => {
  const { t } = useTranslation('settings');

  return (
    <div
      className="bg-muted/40 border border-border rounded-xl p-4 mb-6"
      role="region"
      aria-label={t('background_sync.privacy_model_title')}
    >
      <div className="flex gap-3">
        <Shield
          className="w-5 h-5 text-accent shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="space-y-2 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t('background_sync.privacy_model_title')}
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('background_sync.privacy_model_body')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default BackgroundSyncPrivacyNotice;
