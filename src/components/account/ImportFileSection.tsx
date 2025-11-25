import React, { RefObject } from 'react';
import Button from '../ui/Button';

interface ImportFileSectionProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  isImporting: boolean;
}

const ImportFileSection: React.FC<ImportFileSectionProps> = ({
  fileInputRef,
  onFileImport,
  isImporting,
}) => {
  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="py-6 border-b border-border">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-4">
          Have a contact file?
        </p>
        <Button
          onClick={handleButtonClick}
          variant="primary"
          size="md"
          className="inline-flex items-center gap-2"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
          <span>Select file</span>
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={onFileImport}
          disabled={isImporting}
          aria-label="Import contact from YAML file"
        />
      </div>
    </div>
  );
};

export default ImportFileSection;
