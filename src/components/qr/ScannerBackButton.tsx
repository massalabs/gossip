import React from 'react';
import { CloseIcon } from '../ui/icons';

interface ScannerBackButtonProps {
  onClose: () => void;
}

const ScannerBackButton: React.FC<ScannerBackButtonProps> = ({ onClose }) => {
  return (
    <button
      onClick={onClose}
      className="absolute top-4 left-4 z-20 bg-black/50 backdrop-blur-sm text-white p-3 rounded-full hover:bg-black/70 transition"
      aria-label="Close scanner"
    >
      <CloseIcon />
    </button>
  );
};

export default ScannerBackButton;
