import React from 'react';
import appLogo from '../../assets/gossip_face.svg';
import Button from './Button';

interface PageHeaderProps {
  title: string;
  onBack?: () => void;
  showLogo?: boolean;
  className?: string;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  onBack,
  showLogo = false,
  className = '',
}) => {
  return (
    <div className={`px-6 py-4 border-b border-border ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button
              onClick={onBack}
              variant="circular"
              size="custom"
              className="w-8 h-8 flex items-center justify-center"
            >
              <svg
                className="w-5 h-5 text-gray-600 dark:text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Button>
          )}
          {showLogo && (
            <img
              src={appLogo}
              className="w-9 h-9 rounded object-cover"
              alt="Gossip logo"
            />
          )}
          <h1 className="text-xl font-semibold text-black dark:text-white">
            {title}
          </h1>
        </div>
      </div>
    </div>
  );
};

export default PageHeader;
