import React from 'react';
import { ChevronLeft } from 'react-feather';
import appLogo from '../../assets/gossip_face.svg';
import Button from './Button';

interface PageHeaderProps {
  title: string;
  onBack?: () => void;
  showLogo?: boolean;
  className?: string;
  rightAction?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  onBack,
  showLogo = false,
  className = '',
  rightAction,
}) => {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-3">
        {onBack && (
          <Button
            onClick={onBack}
            variant="circular"
            size="custom"
            ariaLabel="Back"
            className="w-8 h-8 flex items-center justify-center"
          >
            <ChevronLeft className="w-5 h-5 text-muted-foreground" />
          </Button>
        )}
        {showLogo && (
          <img
            src={appLogo}
            className="w-9 h-9 rounded object-cover"
            alt="Gossip logo"
          />
        )}
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      </div>
      {rightAction && <div>{rightAction}</div>}
    </div>
  );
};

export default PageHeader;
