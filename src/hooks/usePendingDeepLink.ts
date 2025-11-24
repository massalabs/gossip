import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { getPendingDeepLink } from '../utils/deepLinkStorage';

/**
 * Hook to handle pending deep links after authentication
 * Parses invite URLs and navigates to the appropriate route
 *
 * This hook should be called in AuthenticatedRoutes to handle deep links
 * when the user becomes authenticated
 */
export const usePendingDeepLink = () => {
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();

  useEffect(() => {
    // Only process pending deep links when user is authenticated
    if (!userProfile) {
      return;
    }

    const handlePendingDeepLink = async () => {
      const pendingLink = await getPendingDeepLink();

      if (!pendingLink) {
        return;
      }

      console.log('Processing pending deep link:', pendingLink);

      // Parse invite URLs: /invite/:userId/:name
      const inviteMatch = pendingLink.match(/^\/invite\/([^/]+)\/?(.*)$/);
      if (inviteMatch) {
        const [, userId, name] = inviteMatch;
        // Navigate directly to new contact page with query params
        const queryParams = new URLSearchParams({ userId });
        if (name) {
          queryParams.set('name', name);
        }
        console.log('Navigating to new-contact with:', { userId, name });
        navigate(`/new-contact?${queryParams.toString()}`, { replace: true });
        return;
      }

      // For other deep links, navigate as-is
      navigate(pendingLink, { replace: true });
    };

    handlePendingDeepLink();
  }, [navigate, userProfile]);
};
