import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from '../components/ui/MainLayout';
import Discussions from '../pages/Discussions';
import Contact from '../pages/Contact';
import Discussion from '../pages/Discussion';
import DiscussionSettings from '../pages/DiscussionSettings';
import NewDiscussion from '../pages/NewDiscussion';
import NewContact from '../pages/NewContact';
import Settings from '../pages/Settings';
import Wallet from '../pages/Wallet';
import { usePendingDeepLink } from '../hooks/usePendingDeepLink';
import { useAppStateRefresh } from '../hooks/useAppStateRefresh';

/**
 * Routes accessible when user is authenticated
 */
export const AuthenticatedRoutes: React.FC = () => {
  useAppStateRefresh();
  usePendingDeepLink();

  return (
    <Routes>
      <Route path="/new-discussion" element={<NewDiscussion />} />
      <Route path="/new-contact" element={<NewContact />} />
      <Route path="/contact/:userId" element={<Contact />} />
      <Route path="/discussion/:userId" element={<Discussion />} />
      <Route
        path="/discussion/:discussionId/settings"
        element={<DiscussionSettings />}
      />
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
