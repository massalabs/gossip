import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../../components/ui/Button';
import RoundedInput from '../../components/ui/RoundedInput';

interface PasswordFormProps {
  password: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (e?: React.MouseEvent | React.KeyboardEvent) => void;
  isLoading: boolean;
  disabled?: boolean;
  hasError: boolean;
  clearError?: () => void;
  onFocusChange?: (focused: boolean) => void;
}

export const PasswordForm: React.FC<PasswordFormProps> = ({
  password,
  onPasswordChange,
  onSubmit,
  isLoading,
  disabled = false,
  hasError,
  clearError,
  onFocusChange,
}) => {
  const { t } = useTranslation('auth');
  const isDisabled = isLoading || disabled;

  return (
    <div className="space-y-2">
      <RoundedInput
        type="password"
        value={password}
        onChange={e => {
          onPasswordChange(e.target.value);
          if (hasError) clearError?.();
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && password.trim() && !isDisabled) {
            e.preventDefault();
            onSubmit(e);
          }
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        placeholder={t('login.password')}
        error={hasError}
        disabled={isDisabled}
      />
      <Button
        type="button"
        onPointerDown={e => e.preventDefault()}
        onClick={onSubmit}
        disabled={isDisabled || !password.trim()}
        loading={isLoading}
        variant="primary"
        fullWidth
        className="h-[51px] rounded-full disabled:bg-primary/20"
      >
        {!isLoading && <span>{t('login.login')}</span>}
      </Button>
    </div>
  );
};
