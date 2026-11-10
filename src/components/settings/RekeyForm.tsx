import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle } from 'react-feather';
import { validatePassword } from '@massalabs/gossip-sdk';
import PageLayout from '../ui/Layout/PageLayout';
import PageHeader from '../ui/PageHeader';
import Button from '../ui/Button';
import RoundedInput from '../ui/RoundedInput';
import BaseModal from '../ui/BaseModal';
import { useAccountStore } from '../../stores/accountStore';
import {
  checkBiometricAvailability,
  openBiometricLoginForUpdate,
  type BiometricUpdateHandle,
} from '../../services/biometricService';
import { startRekey } from '../../services/accountRekey';
import { logger } from '../../utils/logger.ts';

interface RekeyFormProps {
  /** 'password' sets or changes the password; 'refresh' keeps every password. */
  mode: 'password' | 'refresh';
  onBack: () => void;
}

/**
 * Collects everything a rekey needs before anything is modified: the
 * current credential, the new password, and the passwords of every other
 * account to keep. The screen is the same whatever the device holds; it
 * never shows how many accounts exist.
 */
const RekeyForm: React.FC<RekeyFormProps> = ({ mode, onBack }) => {
  const { t } = useTranslation('settings');
  const passwordless = useAccountStore(
    state => state.userProfile?.security.passwordless === true
  );

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otherPasswords, setOtherPasswords] = useState<[string, string]>([
    '',
    '',
  ]);
  const [biometricMethod, setBiometricMethod] = useState<
    'capacitor' | 'webauthn' | 'none'
  >('none');
  const [biometricIncluded, setBiometricIncluded] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const biometricRef = useRef<BiometricUpdateHandle | null>(null);
  const handedOver = useRef(false);

  useEffect(() => {
    // Offered whenever the device has biometrics, whether or not a
    // credential exists: the screen must not reveal that.
    checkBiometricAvailability()
      .then(({ available, method }) => {
        if (available) setBiometricMethod(method ?? 'none');
      })
      .catch(() => {});
    return () => {
      if (!handedOver.current) biometricRef.current?.dispose();
    };
  }, []);

  const includeBiometric = async () => {
    setBiometricBusy(true);
    setError(null);
    try {
      biometricRef.current?.dispose();
      biometricRef.current = await openBiometricLoginForUpdate(biometricMethod);
      setBiometricIncluded(biometricRef.current !== null);
      if (!biometricRef.current) setError(t('security.rekey_biometric_failed'));
    } finally {
      setBiometricBusy(false);
    }
  };

  const newPasswordCheck = validatePassword(newPassword);
  const newPasswordValid = mode === 'refresh' || newPasswordCheck.valid;
  const confirmMismatch =
    mode === 'password' &&
    confirmPassword.length > 0 &&
    confirmPassword !== newPassword;
  const hasCurrentCredential = passwordless
    ? biometricIncluded
    : currentPassword.length > 0;
  const canSubmit =
    hasCurrentCredential &&
    newPasswordValid &&
    (mode === 'refresh' || confirmPassword === newPassword) &&
    !starting;

  const start = async () => {
    setConfirmOpen(false);
    setStarting(true);
    setError(null);
    const credential = passwordless
      ? biometricRef.current?.password
      : currentPassword;
    if (!credential) {
      setStarting(false);
      return;
    }
    try {
      handedOver.current = true;
      await startRekey({
        currentPassword: credential,
        newPassword: mode === 'password' ? newPassword : undefined,
        otherPasswords: otherPasswords.filter(password => password.length > 0),
        biometric: biometricRef.current,
      });
      // On success this screen has already been replaced by the progress
      // screen; nothing more to do here.
    } catch (startError) {
      // Rejected before anything was started.
      handedOver.current = false;
      logger.error('Rekey could not start:', startError);
      setError(t('security.rekey_current_invalid'));
      setStarting(false);
    }
  };

  const title =
    mode === 'refresh'
      ? t('security.refresh_title')
      : passwordless
        ? t('security.rekey_title_set')
        : t('security.rekey_title_change');

  return (
    <PageLayout
      header={
        <PageHeader title={title} onBack={starting ? undefined : onBack} />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <form
        className="space-y-6"
        onSubmit={event => {
          event.preventDefault();
          if (canSubmit) setConfirmOpen(true);
        }}
      >
        {!passwordless && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {t('security.rekey_current_label')}
            </label>
            <RoundedInput
              type="password"
              value={currentPassword}
              onChange={event => {
                setCurrentPassword(event.target.value);
                setError(null);
              }}
              placeholder={t('security.rekey_current_label')}
              disabled={starting}
            />
          </div>
        )}

        {mode === 'password' && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {t('security.rekey_new_label')}
            </label>
            <RoundedInput
              type="password"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              placeholder={t('security.rekey_new_label')}
              error={newPassword.length > 0 && !newPasswordCheck.valid}
              disabled={starting}
            />
            <RoundedInput
              type="password"
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
              placeholder={t('security.rekey_confirm_label')}
              error={confirmMismatch}
              disabled={starting}
            />
            {newPassword.length > 0 && !newPasswordCheck.valid && (
              <p className="text-xs text-destructive">
                {newPasswordCheck.error}
              </p>
            )}
            {confirmMismatch && (
              <p className="text-xs text-destructive">
                {t('security.rekey_mismatch')}
              </p>
            )}
          </div>
        )}

        {biometricMethod !== 'none' && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <p className="text-sm font-semibold text-foreground">
              {t('security.rekey_biometric_title')}
            </p>
            <p className="text-sm text-muted-foreground">
              {passwordless
                ? t('security.rekey_biometric_required')
                : t('security.rekey_biometric_body')}
            </p>
            {biometricIncluded ? (
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CheckCircle className="w-4 h-4 text-success" />
                {t('security.rekey_biometric_included')}
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="custom"
                fullWidth
                className="h-11 rounded-full text-sm font-medium"
                onClick={() => void includeBiometric()}
                loading={biometricBusy}
                disabled={biometricBusy || starting}
              >
                {!biometricBusy && t('security.rekey_biometric_action')}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">
            {t('security.rekey_others_title')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('security.rekey_others_body')}
          </p>
          {otherPasswords.map((value, index) => (
            <RoundedInput
              key={index}
              type="password"
              value={value}
              onChange={event => {
                const next: [string, string] = [...otherPasswords];
                next[index] = event.target.value;
                setOtherPasswords(next);
              }}
              placeholder={t('security.rekey_other_placeholder')}
              disabled={starting}
            />
          ))}
        </div>

        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">
            {t('security.rekey_warning')}
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          size="custom"
          fullWidth
          className="h-11 rounded-full text-sm font-medium"
          disabled={!canSubmit}
          loading={starting}
        >
          {!starting && t('security.rekey_submit')}
        </Button>
      </form>

      <BaseModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('security.rekey_confirm_title')}
      >
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('security.rekey_confirm_body')}
          </p>
          <p className="text-sm text-foreground font-medium leading-relaxed">
            {t('security.rekey_warning')}
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => void start()}
              variant="primary"
              size="custom"
              fullWidth
              className="h-11 rounded-xl text-sm font-medium"
            >
              {t('security.rekey_confirm_start')}
            </Button>
            <Button
              onClick={() => setConfirmOpen(false)}
              variant="outline"
              size="custom"
              fullWidth
              className="h-11 rounded-xl text-sm font-medium"
            >
              {t('common:cancel')}
            </Button>
          </div>
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default RekeyForm;
