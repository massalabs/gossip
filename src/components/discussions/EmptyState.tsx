import React from 'react';
import { PrivacyGraphic } from '../graphics';

const EmptyState: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-6">
      <div className="mb-6">
        <PrivacyGraphic size={96} />
      </div>
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
        No messages yet
      </h3>
      <p className="text-[14px] text-gray-500 dark:text-gray-400 text-center max-w-xs leading-relaxed">
        Start the conversation by sending your first message
      </p>
    </div>
  );
};

export default EmptyState;
