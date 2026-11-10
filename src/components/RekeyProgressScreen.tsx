import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle } from 'react-feather';
import Button from './ui/Button';
import { PrivacyGraphic } from './graphics';
import { useRekeyStore } from '../stores/rekeyStore';

/**
 * Blocking screen shown instead of the app while storage is being
 * re-encrypted, and for its outcome. Nothing else may open storage until the
 * user leaves this screen.
 */
const RekeyProgressScreen: React.FC = () => {
  const { t } = useTranslation('settings');
  const status = useRekeyStore(state => state.status);
  const reloadRequired = useRekeyStore(state => state.reloadRequired);
  const setStatus = useRekeyStore(state => state.setStatus);

  const leave = () => {
    if (reloadRequired) {
      window.location.reload();
      return;
    }
    setStatus('idle');
  };

  return (
    <div className="bg-background flex items-center justify-center h-full px-6">
      <div className="text-center space-y-4 app-max-w w-full">
        {status === 'running' && (
          <>
            <PrivacyGraphic size={120} loading={true} />
            <h1 className="text-xl font-semibold text-foreground">
              {t('security.rekey_running_title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('security.rekey_running_body')}
            </p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-success mx-auto" />
            <h1 className="text-xl font-semibold text-foreground">
              {t('security.rekey_success_title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('security.rekey_success_body')}
            </p>
            <Button
              onClick={leave}
              variant="primary"
              size="custom"
              fullWidth
              className="h-11 rounded-full text-sm font-medium"
            >
              {t('security.rekey_success_action')}
            </Button>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
            <h1 className="text-xl font-semibold text-foreground">
              {t('security.rekey_error_title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('security.rekey_error_body')}
            </p>
            <Button
              onClick={leave}
              variant="primary"
              size="custom"
              fullWidth
              className="h-11 rounded-full text-sm font-medium"
            >
              {t('security.rekey_error_action')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

export default RekeyProgressScreen;
