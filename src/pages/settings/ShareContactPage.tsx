import React from 'react';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../../components/settings/ShareContact';
import { useAccountStore } from '../../stores/accountStore';
import { useUserMnsDomain } from '../../hooks/useUserMnsDomain';
import { ROUTES } from '../../constants/routes';

const ShareContactPage: React.FC = () => {
  const navigate = useNavigate();
  const { userProfile, session } = useAccountStore();
  const { mnsDomains } = useUserMnsDomain();
  const mnsDomain = mnsDomains.length > 0 ? mnsDomains[0] : null;

  const handleBack = () => {
    navigate(-1);
  };

  if (!userProfile || !session) {
    // Redirect to settings if user profile or public key is not available
    navigate(ROUTES.settings());
    return null;
  }

  return (
    <ShareContact
      onBack={handleBack}
      userId={userProfile.userId}
      userName={userProfile.username}
      publicKey={session.ourPk}
      mnsDomain={mnsDomain}
    />
  );
};

export default ShareContactPage;
