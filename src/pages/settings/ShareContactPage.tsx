import React from 'react';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../../components/settings/ShareContact';
import { useAccountStore } from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import { gossipSdk } from 'gossip-sdk';

const ShareContactPage: React.FC = () => {
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const mnsDomains = useAppStore(s => s.mnsDomains);

  const handleBack = () => {
    navigate(-1);
  };

  if (!userProfile || !gossipSdk.isSessionOpen) {
    // Redirect to settings if user profile or public key is not available
    navigate(ROUTES.settings());
    return null;
  }

  return (
    <ShareContact
      onBack={handleBack}
      userId={userProfile.userId}
      userName={userProfile.username}
      publicKey={gossipSdk.publicKeys}
      mnsDomains={mnsEnabled && mnsDomains.length > 0 ? mnsDomains : undefined}
    />
  );
};

export default ShareContactPage;
