import React from 'react';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../../components/settings/ShareContact';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';

const ShareContactPage: React.FC = () => {
  const navigate = useNavigate();
  const { userProfile, ourPk } = useAccountStore();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  if (!userProfile || !ourPk) {
    // Redirect to settings if user profile or public key is not available
    navigate(ROUTES.settings());
    return null;
  }

  return (
    <ShareContact
      onBack={handleBack}
      userId={userProfile.userId}
      userName={userProfile.username}
      publicKey={ourPk}
    />
  );
};

export default ShareContactPage;
