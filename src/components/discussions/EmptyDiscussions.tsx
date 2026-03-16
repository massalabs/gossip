import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { PrivacyGraphic } from '../graphics';

const EmptyDiscussions: React.FC = () => {
  const { t } = useTranslation('discussions');
  return (
    <div className="py-8 text-center">
      <div className="flex justify-center">
        <PrivacyGraphic size={60} />
      </div>
      <p className="text-sm text-muted-foreground mb-4 font-bold">
        {t('empty.no_discussions')}
      </p>
      <p className="text-xs text-muted-foreground">
        <Trans
          i18nKey="empty.no_discussions_hint"
          ns="discussions"
          components={{ strong: <strong /> }}
        />
      </p>
    </div>
  );
};

export default EmptyDiscussions;
