import React from 'react';
import { useTranslation } from 'react-i18next';

const InitializingState: React.FC = () => {
  const { t } = useTranslation('discussions');
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="w-12 h-12 border-[3px] border-blue-100 dark:border-blue-900/30 border-t-blue-600 dark:border-t-blue-500 rounded-full animate-spin"></div>
          <div
            className="absolute inset-0 w-12 h-12 border-[3px] border-transparent border-r-blue-600/30 dark:border-r-blue-500/30 rounded-full animate-spin"
            style={{
              animationDirection: 'reverse',
              animationDuration: '1.5s',
            }}
          ></div>
        </div>
        <div className="text-center">
          <p className="text-[15px] font-semibold text-gray-900 dark:text-white mb-1">
            {t('initializing.title')}
          </p>
          <p className="text-[13px] text-gray-500 dark:text-gray-400">
            {t('initializing.subtitle')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default InitializingState;
