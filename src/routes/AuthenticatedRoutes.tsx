import React from 'react';
import {
  Routes,
  Route,
  Navigate,
  useParams,
  useNavigate,
} from 'react-router-dom';
import MainLayout from '../components/ui/MainLayout';
import Discussions from '../pages/Discussions';
import Contact from '../pages/Contact';
import Discussion from '../pages/Discussion';
import NewDiscussion from '../pages/NewDiscussion';
import NewContact from '../pages/NewContact';
import Settings from '../pages/Settings';
import Wallet from '../pages/Wallet';

// Wrapper component to convert /add/:userId route param to query param
const AddContactRedirect: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (userId) {
      // Parse name from hash (HashRouter stores query params in hash)
      // Format: #/add/{userId}?name={name}
      let name: string | null = null;
      const hash = window.location.hash.replace('#', '');
      const hashParts = hash.split('?');
      if (hashParts.length > 1) {
        const hashParams = new URLSearchParams(hashParts[1]);
        name = hashParams.get('name');
        console.log('[AddContactRedirect] Parsed from hash:', {
          hash,
          hashParts,
          name,
        });
      }

      // Also check regular search params as fallback
      if (!name && window.location.search) {
        const urlParams = new URLSearchParams(window.location.search);
        name = urlParams.get('name');
        console.log('[AddContactRedirect] Parsed from search:', {
          search: window.location.search,
          name,
        });
      }

      // Redirect to /new-contact with userId and optional name as query params
      const params = new URLSearchParams();
      params.set('userId', userId);
      if (name) {
        params.set('name', name);
        console.log('[AddContactRedirect] Including name in redirect:', name);
      } else {
        console.log('[AddContactRedirect] No name found in URL');
      }
      navigate(`/new-contact?${params.toString()}`, {
        replace: true,
      });
    }
  }, [userId, navigate]);

  return <NewContact />;
};

/**
 * Routes accessible when user is authenticated
 */
export const AuthenticatedRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/new-discussion" element={<NewDiscussion />} />
      <Route path="/new-contact" element={<NewContact />} />
      {/* Deep link route for QR code scanning: /add/{userId} */}
      <Route path="/add/:userId" element={<AddContactRedirect />} />
      <Route path="/contact/:userId" element={<Contact />} />
      <Route path="/discussion/:userId" element={<Discussion />} />
      <Route
        path="/wallet"
        element={
          <MainLayout>
            <Wallet />
          </MainLayout>
        }
      />
      <Route
        path="/settings"
        element={
          <MainLayout>
            <Settings />
          </MainLayout>
        }
      />
      <Route
        path="/"
        element={
          <MainLayout>
            <Discussions />
          </MainLayout>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};
