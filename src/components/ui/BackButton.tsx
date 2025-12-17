import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'react-feather';
import Button from './Button';

interface BackButtonProps {
  onClick?: () => void;
  className?: string;
  title?: string;
}

const BackButton: React.FC<BackButtonProps> = ({
  onClick,
  className = '',
  title = 'Go back',
}) => {
  const navigate = useNavigate();

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      // Default: go back in browser history
      navigate(-1);
    }
  };

  return (
    <Button
      onClick={handleClick}
      variant="ghost"
      size="custom"
      className={`p-2 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-muted/50 active:bg-muted/70 transition-colors ${className}`}
      title={title}
    >
      <ChevronLeft className="w-6 h-6" />
    </Button>
  );
};

export default BackButton;
