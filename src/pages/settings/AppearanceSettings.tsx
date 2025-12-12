import React from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
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
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="Appearance" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        <ThemeSelect
          theme={theme}
          resolvedTheme={resolvedTheme}
          onThemeChange={setTheme}
        />
      </ScrollableContent>
    </div>
  );
};

export default AppearanceSettings;

