import { PrivacyGraphic } from './PrivacyGraphic';

const LoadingScreen = () => {
  return (
    <div className="bg-background flex items-center justify-center h-full">
      <div className="text-center">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-sm text-muted-foreground mt-4">Loading...</p>
      </div>
    </div>
  );
};

export default LoadingScreen;
