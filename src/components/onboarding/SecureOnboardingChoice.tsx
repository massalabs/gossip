import React from 'react';
import { PlusCircle, Upload } from 'react-feather';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import PageLayout from '../ui/Layout/PageLayout';

interface SecureOnboardingChoiceProps {
  onCreate: () => void;
  onImport: () => void;
}

const SecureOnboardingChoice: React.FC<SecureOnboardingChoiceProps> = ({
  onCreate,
  onImport,
}) => {
  const { t } = useTranslation('auth');
  return (
    <PageLayout contentClassName="px-6 py-8">
      <div className="app-max-w mx-auto min-h-full flex flex-col justify-center gap-6">
        <div className="text-center space-y-3">
          <img
            src="/logo.svg"
            alt="Gossip"
            className="w-44 h-auto mx-auto dark:invert"
          />
          <h1 className="text-3xl font-bold text-foreground">
            {t('onboarding_choice.title')}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('onboarding_choice.body')}
          </p>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm dark:shadow-none">
            <PlusCircle className="w-7 h-7 text-primary" />
            <div className="space-y-1">
              <h2 className="font-semibold text-foreground">
                {t('onboarding_choice.create_title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('onboarding_choice.create_body')}
              </p>
            </div>
            <Button fullWidth onClick={onCreate}>
              {t('onboarding_choice.create')}
            </Button>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-sm dark:shadow-none">
            <Upload className="w-7 h-7 text-primary" />
            <div className="space-y-1">
              <h2 className="font-semibold text-foreground">
                {t('onboarding_choice.import_title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('onboarding_choice.import_body')}
              </p>
            </div>
            <Button fullWidth variant="outline" onClick={onImport}>
              {t('onboarding_choice.import')}
            </Button>
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default SecureOnboardingChoice;
