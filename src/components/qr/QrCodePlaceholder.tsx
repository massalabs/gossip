import React from 'react';

interface QrCodePlaceholderProps {
  className?: string;
}

const QrCodePlaceholder: React.FC<QrCodePlaceholderProps> = ({
  className = '',
}) => {
  return (
    <div className={`flex justify-center ${className}`}>
      <div className="w-48 h-48 bg-card rounded-2xl flex items-center justify-center border-2 border-dashed border-border">
        <div className="text-center">
          <svg
            className="w-16 h-16 text-muted-foreground mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
            />
          </svg>
          <p className="text-sm text-muted-foreground">QR Code</p>
          <p className="text-xs text-muted-foreground/70">Coming soon</p>
        </div>
      </div>
    </div>
  );
};

export default QrCodePlaceholder;
