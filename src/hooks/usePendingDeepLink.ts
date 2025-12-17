import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { ROUTES } from '../constants/routes';

/**
 * Hook to handle pending deep links after authentication
 * Parses invite URLs and navigates to the appropriate route
 *
 * This hook should be called in AuthenticatedRoutes to handle deep links
 */
export const usePendingDeepLink = () => {
  const pendingDeepLinkInfo = useAppStore(s => s.pendingDeepLinkInfo);
  const setPendingDeepLinkInfo = useAppStore(s => s.setPendingDeepLinkInfo);
  const navigate = useNavigate();

  useEffect(() => {
    const handlePendingDeepLink = async () => {
      if (!pendingDeepLinkInfo) return;

      try {
        navigate(ROUTES.newContact(), {
          state: pendingDeepLinkInfo,
        });
      } catch (error) {
        console.error('Failed to retrieve pending deep link:', error);
      } finally {
        setPendingDeepLinkInfo(null);
      }
    };

    handlePendingDeepLink();
  }, [navigate, pendingDeepLinkInfo, setPendingDeepLinkInfo]);
};
