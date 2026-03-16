import React from 'react';
import { X, Copy, Trash2 } from 'react-feather';
import HeaderBar from '../ui/HeaderBar';
import Button from '../ui/Button';
import AnimatedCounter from '../ui/AnimatedCounter';

interface SelectionHeaderProps {
  count: number;
  onClear: () => void;
  onCopy: () => void;
  onDelete: () => void;
  canDelete?: boolean;
}

const SelectionHeader: React.FC<SelectionHeaderProps> = ({
  count,
  onClear,
  onCopy,
  onDelete,
  canDelete = true,
}) => {
  return (
    <HeaderBar>
      <div className="flex items-center w-full gap-3">
        <Button
          onClick={onClear}
          variant="circular"
          size="custom"
          ariaLabel="Clear selection"
          className="w-8 h-8 flex items-center justify-center"
        >
          <X className="w-5 h-5 text-muted-foreground" />
        </Button>
        <AnimatedCounter value={count} />
        <div className="flex-1" />
        <Button
          onClick={onCopy}
          variant="circular"
          size="custom"
          ariaLabel="Copy selected messages"
          className="w-8 h-8 flex items-center justify-center"
        >
          <Copy className="w-5 h-5 text-muted-foreground" />
        </Button>
        {canDelete ? (
          <Button
            onClick={onDelete}
            variant="circular"
            size="custom"
            ariaLabel="Delete selected messages"
            className="w-8 h-8 flex items-center justify-center"
          >
            <Trash2 className="w-5 h-5 text-destructive" />
          </Button>
        ) : null}
      </div>
    </HeaderBar>
  );
};

export default SelectionHeader;
