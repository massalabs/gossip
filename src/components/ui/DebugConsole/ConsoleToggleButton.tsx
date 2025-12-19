import React from 'react';
import Button from '../Button';
import { Terminal } from 'react-feather';

interface ConsoleToggleButtonProps {
  onOpen: () => void;
}

export const ConsoleToggleButton: React.FC<ConsoleToggleButtonProps> = ({
  onOpen,
}) => {
  return (
    <Button
      className="absolute bottom-20 left-2 z-9999"
      onClick={onOpen}
      variant="secondary"
    >
      <span className="flex items-center gap-1">
        <Terminal className="w-4 h-4" />
        <span>Console</span>
      </span>
    </Button>
  );
};
