import React, { RefObject } from 'react';
import { Upload } from 'react-feather';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('contacts');

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="py-6 border-b border-border">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-4">
          {t('have_contact_file')}
        </p>
        <Button
          onClick={handleButtonClick}
          variant="primary"
          size="md"
          className="inline-flex items-center gap-2"
        >
          <Upload className="w-5 h-5" aria-hidden="true" />
          <span>{t('select_file')}</span>
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={onFileImport}
          disabled={isImporting}
          aria-label={t('new_contact.import_file_aria')}
        />
      </div>
    </div>
  );
};

export default ImportFileSection;
