import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { setPendingDeepLink } from '../utils/deepLinkStorage';

export const InviteRoute = () => {
  const { userId, name } = useParams<{ userId: string; name: string }>();
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();

  useEffect(() => {
    if (!userId) {
      navigate('/', { replace: true });
      return;
    }

    if (userProfile) {
      navigate(`/new-contact?userId=${userId}&name=${name}`, { replace: true });
      return;
    }

    // store and redirect to welcome if not logged in
    const deepLink = `/invite/${userId}/${name}`;
    setPendingDeepLink(deepLink).then(() => {
      navigate('/welcome', { replace: true });
    });
  }, [userId, name, userProfile, navigate]);

  return null;
};
