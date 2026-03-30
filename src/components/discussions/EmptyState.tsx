import React from 'react';
import { useTranslation } from 'react-i18next';
import { PrivacyGraphic } from '../graphics';

const EmptyState: React.FC = () => {
  const { t } = useTranslation('discussions');
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="mb-6">
        <PrivacyGraphic size={96} />
      </div>
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
        {t('empty.no_messages')}
      </h3>
      <p className="text-[14px] text-gray-500 dark:text-gray-400 text-center max-w-xs leading-relaxed">
        {t('empty.no_messages_hint')}
      </p>
    </div>
  );
};

export default EmptyState;
