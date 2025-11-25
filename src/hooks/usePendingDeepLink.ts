import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { getPendingDeepLink } from '../utils/deepLinkStorage';
import { parseInvite } from '../utils/qrCodeParser';

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
      try {
        const pendingLink = await getPendingDeepLink();

        if (!pendingLink) {
          return;
        }

        // Parse invite URLs: /invite/:userId/:name
        const invitePath = pendingLink.startsWith('/invite/')
          ? pendingLink
          : null;
        if (invitePath) {
          try {
            const { userId, name } = parseInvite(invitePath);
            const queryParams = new URLSearchParams({ userId });
            if (name) {
              queryParams.set('name', name);
            }
            navigate(`/new-contact?${queryParams.toString()}`, {
              replace: true,
            });
            return;
          } catch (error) {
            console.error('Failed to parse pending invite:', error);
          }
        }

        // For other deep links, navigate as-is
        navigate(pendingLink, { replace: true });
      } catch (error) {
        console.error('Failed to retrieve pending deep link:', error);
      }
    };

    handlePendingDeepLink();
  }, [navigate, userProfile]);
};
