import React from 'react';
import { useTranslation } from 'react-i18next';

const LoadingState: React.FC = () => {
  const { t } = useTranslation('discussions');
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-[3px] border-gray-200 dark:border-gray-700 border-t-blue-600 dark:border-t-blue-500 rounded-full animate-spin"></div>
        <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">
          {t('loading_messages')}
        </p>
      </div>
    </div>
  );
};

export default LoadingState;
