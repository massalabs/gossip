import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import { scrollFieldIntoView } from '../../utils/scrollFieldIntoView';

interface BiometricPasswordModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  onConfirm: (password: string) => void | Promise<void>;
  onClose: () => void;
}

const BiometricPasswordModal: React.FC<BiometricPasswordModalProps> = ({
  isOpen,
  isSubmitting,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('settings');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setShowPassword(false);
    }
  }, [isOpen]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || isSubmitting) return;
    const submittedPassword = password;
    setPassword('');
    void onConfirm(submittedPassword);
  };

  const handleClose = () => {
    setPassword('');
    onClose();
  };

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('security.biometric_password_title')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('security.biometric_password_description')}
        </p>
        <RoundedInput
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          onFocus={scrollFieldIntoView}
          placeholder={t('security.biometric_password_placeholder')}
          disabled={isSubmitting}
          showPasswordToggle={true}
          showPassword={showPassword}
          onShowPasswordChange={setShowPassword}
        />
        <div className="flex flex-col gap-2 pt-2">
          <Button
            type="submit"
            disabled={!password || isSubmitting}
            loading={isSubmitting}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {!isSubmitting && t('security.biometric_password_continue')}
          </Button>
          <Button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-medium"
          >
            {t('security.biometric_password_cancel')}
          </Button>
        </div>
      </form>
    </BaseModal>
  );
};

export default BiometricPasswordModal;
