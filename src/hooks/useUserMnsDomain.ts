import { useState, useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { mnsService } from '../services/mns';

/**
 * Hook to get the user's MNS domains (if registered)
 * Returns all MNS domains pointing to the user's gossip ID
 */
export function useUserMnsDomain(): {
  mnsDomains: string[];
  isLoading: boolean;
} {
  const { userProfile, provider } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const [mnsDomains, setMnsDomains] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const fetchMnsDomains = async () => {
      if (!mnsEnabled || !userProfile?.userId || !provider) {
        setMnsDomains([]);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        const domains = await mnsService.getDomainsFromGossipId(
          userProfile.userId
        );

        if (isMounted) {
          const domainsWithSuffix = domains.map(domain => `${domain}.massa`);

          setMnsDomains(domainsWithSuffix);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error fetching user MNS domains:', error);
        if (isMounted) {
          setMnsDomains([]);
          setIsLoading(false);
        }
      }
    };

    fetchMnsDomains();

    return () => {
      isMounted = false;
    };
  }, [mnsEnabled, userProfile?.userId, provider]);

  return {
    mnsDomains,
    isLoading,
  };
}
