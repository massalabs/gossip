import React from 'react';
import { Check as CheckIcon } from 'react-feather';

interface SelectionCheckboxProps {
  isVisible: boolean;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
}

const SelectionCheckbox: React.FC<SelectionCheckboxProps> = ({
  isVisible,
  isSelected,
  onClick,
}) => (
  <div
    className={`absolute left-1 top-0 bottom-0 flex items-center justify-center transition-opacity duration-200 ease-out ${
      isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`}
    onClick={onClick}
    data-testid="select-checkbox"
  >
    <div
      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors duration-150 ${
        isSelected
          ? 'bg-accent border-accent'
          : 'border-muted-foreground/40 bg-transparent'
      }`}
    >
      {isSelected && (
        <CheckIcon className="w-3 h-3 text-accent-foreground" strokeWidth={3} />
      )}
    </div>
  </div>
);

export default SelectionCheckbox;
