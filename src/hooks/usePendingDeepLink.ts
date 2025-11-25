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
  const navigate = useNavigate();

  useEffect(() => {
    const handlePendingDeepLink = async () => {
      if (!pendingDeepLink) return;

      try {
        try {
          const { userId, name } = parseInvite(pendingDeepLink);

          navigate(`/new-contact`, {
            replace: true,
            state: { userId, name },
          });
          return;
        } catch (error) {
          console.error('Failed to parse pending invite:', error);
        }
      } catch (error) {
        console.error('Failed to retrieve pending deep link:', error);
      }
    };

    handlePendingDeepLink();
  }, [navigate, pendingDeepLink]);
};
