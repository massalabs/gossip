import React from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'react-feather';
import { useOnlineStore } from '../../stores/useOnlineStore';

const ConnectionBanner: React.FC = () => {
  const { t } = useTranslation('discussions');
  const isOnline = useOnlineStore(s => s.isOnline);

  if (isOnline) return null;

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-warning/15 text-warning text-xs font-medium">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>{t('waiting_connection')}</span>
    </div>
  );
};

export default ConnectionBanner;
