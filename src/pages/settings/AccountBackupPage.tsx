import React from 'react';
import { useNavigate } from 'react-router-dom';
import AccountBackup from '../../components/account/AccountBackup';
import { ROUTES } from '../../constants/routes';

const AccountBackupPage: React.FC = () => {
  const navigate = useNavigate();

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return <AccountBackup onBack={handleBack} />;
};

export default AccountBackupPage;
