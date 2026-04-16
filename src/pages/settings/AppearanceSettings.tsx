import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Navigation } from 'react-feather';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import ThemeSelect from '../../components/settings/ThemeSelect';
import Toggle from '../../components/ui/Toggle';
import { useTheme } from '../../hooks/useTheme';
import { useUiStore } from '../../stores/uiStore';
import { ROUTES } from '../../constants/routes';

const AppearanceSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const showBottomNav = useUiStore.use.showBottomNav();
  const setShowBottomNav = useUiStore.use.setShowBottomNav();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title={t('appearance.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <ThemeSelect
        theme={theme}
        resolvedTheme={resolvedTheme}
        onThemeChange={setTheme}
      />

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="h-[54px] flex items-center px-4 justify-start w-full">
          <Navigation className="w-5 h-5 text-foreground mr-4" />
          <span className="text-base font-medium text-foreground flex-1 text-left">
            Bottom navigation bar
          </span>
          <Toggle
            checked={showBottomNav}
            onChange={setShowBottomNav}
            ariaLabel="Toggle bottom navigation bar"
          />
        </div>
      </div>
    </PageLayout>
  );
};

export default AppearanceSettings;
