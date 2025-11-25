import React from 'react';

interface ErrorDisplayProps {
  error: string | null;
}

const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error }) => {
  if (!error) return null;

  return (
    <div
      className="p-4 bg-destructive/10 border border-destructive/50 rounded-xl text-sm text-destructive"
      role="alert"
    >
      {error}
    </div>
  );
};

export default ErrorDisplay;
