import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check } from 'react-feather';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import { useUiStore } from '../../stores/uiStore';
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  type SupportedLanguage,
} from '../../i18n';
import { ROUTES } from '../../constants/routes';

const LanguageSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const language = useUiStore.use.language();
  const setLanguage = useUiStore.use.setLanguage();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleLanguageChange = (lang: SupportedLanguage) => {
    setLanguage(lang);
  };

  return (
    <PageLayout
      header={<PageHeader title={t('language.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {SUPPORTED_LANGUAGES.map((lang, index) => (
          <button
            key={lang}
            onClick={() => handleLanguageChange(lang)}
            className={`w-full h-[54px] flex items-center px-4 text-left transition-colors hover:bg-muted/50 ${
              index < SUPPORTED_LANGUAGES.length - 1
                ? 'border-b border-border'
                : ''
            }`}
          >
            <span className="text-base font-medium text-foreground flex-1">
              {LANGUAGE_NAMES[lang]}
            </span>
            {language === lang && <Check className="w-5 h-5 text-primary" />}
          </button>
        ))}
      </div>
    </PageLayout>
  );
};

export default LanguageSettings;
