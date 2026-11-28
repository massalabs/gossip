import React from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Zap } from 'react-feather';
import Button from '../ui/Button';
import PageLayout from '../ui/Layout/PageLayout';
import { PrivacyGraphic } from '../graphics';

interface WelcomeProps {
  onCreate: () => void;
  /** Advanced setup of several deniable accounts; omitted when unavailable. */
  onCreateMultiple?: () => void;
  /** Omitted when restoring is not available. */
  onRestore?: () => void;
  onShowTerms: () => void;
}

/** First onboarding screen: create, deniable setup, restore, terms notice. */
const Welcome: React.FC<WelcomeProps> = ({
  onCreate,
  onCreateMultiple,
  onRestore,
  onShowTerms,
}) => {
  const { t } = useTranslation('onboarding');
  return (
    <PageLayout contentClassName="px-6 py-8">
      <div className="app-max-w mx-auto min-h-full flex flex-col justify-between gap-8">
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-6">
          <PrivacyGraphic size={200} />
          <h1 className="text-3xl font-bold text-foreground leading-tight">
            {t('welcome.title')}
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed">
            {t('welcome.description')}
          </p>
        </div>

        <div className="space-y-3">
          <Button
            onClick={onCreate}
            variant="primary"
            size="custom"
            fullWidth
            className="h-14 text-base font-semibold rounded-full gap-2"
          >
            <Zap />
            {t('new_account')}
          </Button>
          {onCreateMultiple && (
            <Button
              onClick={onCreateMultiple}
              variant="outline"
              size="custom"
              fullWidth
              className="h-14 text-base font-semibold rounded-full gap-2"
            >
              <Shield />
              {t('multiple_accounts')}
            </Button>
          )}
          {onRestore && (
            <Button
              onClick={onRestore}
              variant="ghost"
              size="custom"
              fullWidth
              className="h-14 text-base font-semibold rounded-full"
            >
              {t('restore')}
            </Button>
          )}
          <p className="text-xs text-muted-foreground text-center pt-2">
            {t('terms_notice')}{' '}
            <button
              type="button"
              onClick={onShowTerms}
              className="underline text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              {t('terms_link')}
            </button>
          </p>
        </div>
      </div>
    </PageLayout>
  );
};

export default Welcome;
