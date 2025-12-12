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
import SecuritySettings from '../pages/settings/SecuritySettings';
import NotificationsSettings from '../pages/settings/NotificationsSettings';
import AppearanceSettings from '../pages/settings/AppearanceSettings';
import AboutSettings from '../pages/settings/AboutSettings';
import DebugSettings from '../pages/settings/DebugSettings';
import { InvitePage } from '../pages/InvitePage';
import { usePendingDeepLink } from '../hooks/usePendingDeepLink';
import { useAppStateRefresh } from '../hooks/useAppStateRefresh';
import { ROUTES } from '../constants/routes';

/**
 * Routes accessible when user is authenticated
 */
export const AuthenticatedRoutes: React.FC = () => {
  useAppStateRefresh();
  usePendingDeepLink();

  return (
    <Routes>
      <Route path={ROUTES.invite()} element={<InvitePage />} />
      <Route path={ROUTES.newDiscussion()} element={<NewDiscussion />} />
      <Route path={ROUTES.newContact()} element={<NewContact />} />
      <Route path={ROUTES.contact()} element={<Contact />} />
      <Route path={ROUTES.discussion()} element={<Discussion />} />
      <Route
        path={ROUTES.discussionSettings()}
        element={<DiscussionSettings />}
      />
      <Route
        path={ROUTES.settings()}
        element={
          <MainLayout>
            <Settings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.settingsSecurity()}
        element={
          <MainLayout>
            <SecuritySettings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.settingsNotifications()}
        element={
          <MainLayout>
            <NotificationsSettings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.settingsAppearance()}
        element={
          <MainLayout>
            <AppearanceSettings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.settingsAbout()}
        element={
          <MainLayout>
            <AboutSettings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.settingsDebug()}
        element={
          <MainLayout>
            <DebugSettings />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.discussions()}
        element={
          <MainLayout>
            <Discussions />
          </MainLayout>
        }
      />
      <Route
        path={ROUTES.default()}
        element={<Navigate to={ROUTES.discussions()} replace />}
      />
      <Route
        path="*"
        element={<Navigate to={ROUTES.discussions()} replace />}
      />
    </Routes>
  );
};
