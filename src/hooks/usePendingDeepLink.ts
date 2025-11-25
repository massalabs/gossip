import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseInvite } from '../utils/qrCodeParser';
import { useAppStore } from '../stores/appStore';

/**
 * Hook to handle pending deep links after authentication
 * Parses invite URLs and navigates to the appropriate route
 *
 * This hook should be called in AuthenticatedRoutes to handle deep links
 * when the user becomes authenticated
 */
export const usePendingDeepLink = () => {
  const pendingDeepLink = useAppStore(s => s.pendingDeepLink);
  const setPendingDeepLink = useAppStore(s => s.setPendingDeepLink);
  const navigate = useNavigate();

  useEffect(() => {
    const handlePendingDeepLink = async () => {
      if (!pendingDeepLink) return;

      try {
        const { userId, name } = parseInvite(pendingDeepLink);

        navigate(`/new-contact`, {
          replace: true,
          state: { userId, name },
        });
      } catch (error) {
        console.error('Failed to retrieve pending deep link:', error);
      } finally {
        setPendingDeepLink(null);
      }
    };

    handlePendingDeepLink();
  }, [navigate, pendingDeepLink, setPendingDeepLink]);
};
