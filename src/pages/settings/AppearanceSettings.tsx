import React from 'react';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import ThemeSelect from '../../components/settings/ThemeSelect';
import { useTheme } from '../../hooks/useTheme';
import { ROUTES } from '../../constants/routes';

const AppearanceSettings: React.FC = () => {
  const navigate = useNavigate();
  const { theme, setTheme, resolvedTheme } = useTheme();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title="Appearance" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <ThemeSelect
        theme={theme}
        resolvedTheme={resolvedTheme}
        onThemeChange={setTheme}
      />
    </PageLayout>
  );
};

export default AppearanceSettings;
