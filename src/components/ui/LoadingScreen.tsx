import { useTranslation } from 'react-i18next';
import { PrivacyGraphic } from '../graphics';

const LoadingScreen = () => {
  const { t } = useTranslation();

  return (
    <div className="bg-background flex items-center justify-center h-full">
      <div className="text-center">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-sm text-muted-foreground mt-4">{t('loading')}</p>
      </div>
    </div>
  );
};

export default LoadingScreen;
