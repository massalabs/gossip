import React from 'react';
import { Share2 } from 'react-feather';
import Button from '../ui/Button';

interface ShareContactFileSectionProps {
  disabled: boolean;
  isLoading: boolean;
  error: string | null;
  onShare: () => void;
}

const ShareContactFileSection: React.FC<ShareContactFileSectionProps> = ({
  disabled,
  isLoading,
  error,
  onShare,
}) => {
  return (
    <div className="bg-card rounded-xl border border-border p-6 mb-6">
      <div className="text-center mb-6">
        <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
          <Share2 className="w-6 h-6 text-primary" />
        </div>
        <h4 className="text-lg font-normal text-foreground mb-2">
          Share with file
        </h4>
        <p className="text-sm text-muted-foreground mb-6">
          Share your profile as a file with people you want to talk to.
        </p>
      </div>

      <Button
        onClick={onShare}
        disabled={disabled}
        loading={isLoading}
        variant="primary"
        size="custom"
        fullWidth
        className="h-11 rounded-xl text-sm font-normal"
      >
        Share file
      </Button>

      {error && (
        <div className="mt-4 text-sm text-destructive text-center">{error}</div>
      )}
    </div>
  );
};

export default ShareContactFileSection;
