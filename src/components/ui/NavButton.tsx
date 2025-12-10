import React from 'react';
import Button from './Button';

interface NavButtonProps {
  onClick: () => void;
  isActive: boolean;
  title: string;
  icon: React.ReactNode;
  animationVariant?: 'default' | 'alt';
}

const NavButton: React.FC<NavButtonProps> = ({
  onClick,
  isActive,
  title,
  icon,
  animationVariant = 'default',
}) => {
  return (
    <Button
      onClick={onClick}
      variant="circular"
      size="custom"
      className={`w-11 h-11 transition-all duration-200 focus:ring-0 focus:ring-offset-0 focus:outline-none outline-none ${
        animationVariant === 'alt' ? 'nav-button-click-alt' : 'nav-button-click'
      } ${
        isActive
          ? 'bg-primary/10 shadow-inner shadow-primary/10 dark:shadow-none scale-[1.02]'
          : 'hover:bg-muted'
      }`}
      title={title}
    >
      <div
        className={`w-6 h-6 transition-colors ${
          isActive ? 'text-primary' : 'text-muted-foreground'
        }`}
      >
        {icon}
      </div>
    </Button>
  );
};

export default NavButton;
