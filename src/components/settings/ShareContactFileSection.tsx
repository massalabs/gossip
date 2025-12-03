import React from 'react';
import { Download } from 'react-feather';
import Button from '../ui/Button';

interface ShareContactFileSectionProps {
  disabled: boolean;
  isLoading: boolean;
  error: string | null;
  onExport: () => void;
}

const ShareContactFileSection: React.FC<ShareContactFileSectionProps> = ({
  disabled,
  isLoading,
  error,
  onExport,
}) => {
  return (
    <div className="bg-card rounded-lg p-6">
      <div className="text-center mb-6">
        <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
          <Download className="w-6 h-6 text-primary" />
        </div>
        <h4 className="text-lg font-semibold text-foreground mb-2">
          Share with file
        </h4>
        <p className="text-sm text-muted-foreground mb-6">
          Download your profile file and share it with people you want to talk
          to.
        </p>
      </div>

      <Button
        onClick={onExport}
        disabled={disabled}
        loading={isLoading}
        variant="primary"
        size="custom"
        fullWidth
        className="h-11 rounded-xl text-sm font-medium"
      >
        <Download />
        <span>Download</span>
      </Button>

      {error && (
        <div className="mt-4 text-sm text-destructive text-center">{error}</div>
      )}
    </div>
  );
};

export default ShareContactFileSection;
