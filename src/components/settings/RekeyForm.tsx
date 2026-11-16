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
  /** 'password' sets or changes passwords; 'refresh' keeps every password. */
  mode: 'password' | 'refresh';
  onBack: () => void;
}

type Group = 'change' | 'keep';

interface Entry {
  id: number;
  group: Group;
  /** Typed current password. Unused while `biometric` is set. */
  credential: string;
  /** The credential is the secret read through the biometric prompt. */
  biometric: boolean;
  newPassword: string;
  confirmPassword: string;
}

/** A device holds at most three accounts. */
const MAX_ENTRIES = 3;

const newEntry = (id: number, group: Group): Entry => ({
  id,
  group,
  credential: '',
  biometric: false,
  newPassword: '',
  confirmPassword: '',
});

const linkButtonClass =
  'text-sm font-medium text-accent-soft-foreground disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * Collects everything a rekey needs before anything is modified: every
 * account to keep, each with its current credential, and a new password for
 * those that change. Several passwords can change in one operation. The
 * screen is the same whatever the device holds; it never shows how many
 * accounts exist, and every button is always visible (disabled when it
 * would break a limit).
 */
const RekeyForm: React.FC<RekeyFormProps> = ({ mode, onBack }) => {
  const { t } = useTranslation('settings');
  const passwordless = useAccountStore(
    state => state.userProfile?.security.passwordless === true
  );

  const nextId = useRef(1);
  const [entries, setEntries] = useState<Entry[]>(() => [
    newEntry(0, mode === 'password' ? 'change' : 'keep'),
  ]);
  const [biometricMethod, setBiometricMethod] = useState<
    'capacitor' | 'webauthn' | 'none'
  >('none');
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

  const changeCount = entries.filter(entry => entry.group === 'change').length;
  const keepCount = entries.length - changeCount;
  const full = entries.length >= MAX_ENTRIES;
  const biometricUsed = entries.some(entry => entry.biometric);
  // The group that must never be empty: at least one password changes in
  // 'password' mode, at least one account is kept in 'refresh' mode.
  const requiredGroup: Group = mode === 'password' ? 'change' : 'keep';
  const isLastRequired = (entry: Entry) =>
    entry.group === requiredGroup &&
    (requiredGroup === 'change' ? changeCount : keepCount) === 1;

  const update = (id: number, patch: Partial<Entry>) => {
    setError(null);
    setEntries(current =>
      current.map(entry => (entry.id === id ? { ...entry, ...patch } : entry))
    );
  };

  const releaseBiometric = () => {
    biometricRef.current?.dispose();
    biometricRef.current = null;
  };

  const add = (group: Group) => {
    if (full) return;
    setEntries(current => [...current, newEntry(nextId.current++, group)]);
  };

  const remove = (entry: Entry) => {
    if (isLastRequired(entry)) return;
    if (entry.biometric) releaseBiometric();
    setError(null);
    setEntries(current => current.filter(other => other.id !== entry.id));
  };

  const move = (entry: Entry, group: Group) => {
    if (group !== requiredGroup && isLastRequired(entry)) return;
    update(entry.id, { group, newPassword: '', confirmPassword: '' });
  };

  const unlockWithBiometric = async (entry: Entry) => {
    setBiometricBusy(true);
    setError(null);
    try {
      releaseBiometric();
      biometricRef.current = await openBiometricLoginForUpdate(biometricMethod);
      if (biometricRef.current) {
        update(entry.id, { biometric: true, credential: '' });
      } else {
        setError(t('security.rekey_biometric_failed'));
      }
    } finally {
      setBiometricBusy(false);
    }
  };

  const credentialOf = (entry: Entry) =>
    entry.biometric ? (biometricRef.current?.password ?? '') : entry.credential;
  const finalOf = (entry: Entry) =>
    entry.group === 'change' ? entry.newPassword : credentialOf(entry);
  const hasDuplicate = (values: string[]) => {
    const filled = values.filter(value => value.length > 0);
    return new Set(filled).size !== filled.length;
  };

  const duplicate =
    hasDuplicate(entries.map(credentialOf)) ||
    hasDuplicate(entries.map(finalOf));
  const complete = entries.every(entry => {
    if (credentialOf(entry).length === 0) return false;
    if (entry.group === 'keep') return true;
    return (
      validatePassword(entry.newPassword).valid &&
      entry.confirmPassword === entry.newPassword
    );
  });
  const canSubmit = complete && !duplicate && !starting;

  const start = async () => {
    setConfirmOpen(false);
    setStarting(true);
    setError(null);
    try {
      handedOver.current = true;
      await startRekey({
        accounts: entries.map(entry => ({
          credential: credentialOf(entry),
          newPassword: entry.group === 'change' ? entry.newPassword : undefined,
        })),
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

  const renderEntry = (entry: Entry) => {
    const check = validatePassword(entry.newPassword);
    const invalidNew = entry.newPassword.length > 0 && !check.valid;
    const mismatch =
      entry.confirmPassword.length > 0 &&
      entry.confirmPassword !== entry.newPassword;
    return (
      <div
        key={entry.id}
        className="bg-card border border-border rounded-xl p-4 space-y-3"
      >
        {entry.biometric ? (
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CheckCircle className="w-4 h-4 text-success" />
              {t('security.rekey_biometric_included')}
            </p>
            <button
              type="button"
              className={linkButtonClass}
              disabled={starting}
              onClick={() => {
                releaseBiometric();
                update(entry.id, { biometric: false });
              }}
            >
              {t('security.rekey_biometric_undo')}
            </button>
          </div>
        ) : (
          <RoundedInput
            type="password"
            value={entry.credential}
            onChange={event =>
              update(entry.id, { credential: event.target.value })
            }
            placeholder={t('security.rekey_current_label')}
            aria-label={t('security.rekey_current_label')}
            disabled={starting}
          />
        )}

        {entry.group === 'change' && (
          <>
            <RoundedInput
              type="password"
              value={entry.newPassword}
              onChange={event =>
                update(entry.id, { newPassword: event.target.value })
              }
              placeholder={t('security.rekey_new_label')}
              aria-label={t('security.rekey_new_label')}
              error={invalidNew}
              disabled={starting}
            />
            <RoundedInput
              type="password"
              value={entry.confirmPassword}
              onChange={event =>
                update(entry.id, { confirmPassword: event.target.value })
              }
              placeholder={t('security.rekey_confirm_label')}
              aria-label={t('security.rekey_confirm_label')}
              error={mismatch}
              disabled={starting}
            />
            {invalidNew && (
              <p className="text-xs text-destructive">{check.error}</p>
            )}
            {mismatch && (
              <p className="text-xs text-destructive">
                {t('security.rekey_mismatch')}
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {biometricMethod !== 'none' && !entry.biometric && (
            <button
              type="button"
              className={linkButtonClass}
              disabled={biometricUsed || biometricBusy || starting}
              onClick={() => void unlockWithBiometric(entry)}
            >
              {t('security.rekey_biometric_action')}
            </button>
          )}
          {mode === 'password' && (
            <button
              type="button"
              className={linkButtonClass}
              disabled={
                starting || (entry.group === 'change' && isLastRequired(entry))
              }
              onClick={() =>
                move(entry, entry.group === 'change' ? 'keep' : 'change')
              }
            >
              {entry.group === 'change'
                ? t('security.rekey_move_to_keep')
                : t('security.rekey_move_to_change')}
            </button>
          )}
          <button
            type="button"
            className={linkButtonClass}
            disabled={starting || isLastRequired(entry)}
            onClick={() => remove(entry)}
          >
            {t('security.rekey_remove')}
          </button>
        </div>
      </div>
    );
  };

  const renderGroup = (group: Group) => (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">
        {group === 'change'
          ? t('security.rekey_change_section')
          : t('security.rekey_keep_section')}
      </p>
      {entries.filter(entry => entry.group === group).map(renderEntry)}
      <Button
        type="button"
        variant="outline"
        size="custom"
        fullWidth
        className="h-11 rounded-full text-sm font-medium"
        onClick={() => add(group)}
        disabled={full || starting}
      >
        {group === 'change'
          ? t('security.rekey_add_change')
          : t('security.rekey_add_keep')}
      </Button>
    </div>
  );

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
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('security.rekey_intro')}
          </p>
          {mode === 'password' && (
            <p className="text-sm text-muted-foreground">
              {t('security.rekey_all_advice')}
            </p>
          )}
          {passwordless && !biometricUsed && (
            <p className="text-sm text-foreground">
              {t('security.rekey_biometric_required')}
            </p>
          )}
        </div>

        {mode === 'password' && renderGroup('change')}
        {renderGroup('keep')}

        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">
            {t('security.rekey_warning')}
          </p>
        </div>

        {(error || duplicate) && (
          <p className="text-sm text-destructive" role="alert">
            {error ?? t('security.rekey_duplicate')}
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
