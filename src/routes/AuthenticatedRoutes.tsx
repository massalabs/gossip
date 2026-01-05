import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
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
import AccountBackupPage from '../pages/settings/AccountBackupPage';
import ShareContactPage from '../pages/settings/ShareContactPage';
import ContactSharePage from '../pages/ContactSharePage';
import { InvitePage } from '../pages/InvitePage';
import { usePendingDeepLink } from '../hooks/usePendingDeepLink';
import { usePendingSharedContent } from '../hooks/usePendingSharedContent';
import { useAppStateRefresh } from '../hooks/useAppStateRefresh';
import { ROUTES } from '../constants/routes';
import MainLayout from '../components/ui/MainLayout';

/**
 * Routes accessible when user is authenticated.
 *
 * MainLayout automatically shows/hides bottom nav based on route.
 * Configure which routes show bottom nav in `src/constants/pageConfig.ts`
 */
export const AuthenticatedRoutes: React.FC = () => {
  useAppStateRefresh();
  usePendingDeepLink();
  usePendingSharedContent();

  return (
    <MainLayout>
      <Routes>
        <Route path={ROUTES.invite()} element={<InvitePage />} />
        <Route path={ROUTES.newDiscussion()} element={<NewDiscussion />} />
        <Route path={ROUTES.newContact()} element={<NewContact />} />
        <Route path={ROUTES.contact()} element={<Contact />} />
        <Route path={ROUTES.contactShare()} element={<ContactSharePage />} />
        <Route path={ROUTES.discussion()} element={<Discussion />} />
        <Route
          path={ROUTES.discussionSettings()}
          element={<DiscussionSettings />}
        />
        <Route
          path={ROUTES.settingsSecurity()}
          element={<SecuritySettings />}
        />
        <Route
          path={ROUTES.settingsNotifications()}
          element={<NotificationsSettings />}
        />
        <Route
          path={ROUTES.settingsAppearance()}
          element={<AppearanceSettings />}
        />
        <Route path={ROUTES.settingsAbout()} element={<AboutSettings />} />
        <Route path={ROUTES.settingsDebug()} element={<DebugSettings />} />
        <Route
          path={ROUTES.settingsAccountBackup()}
          element={<AccountBackupPage />}
        />
        <Route
          path={ROUTES.settingsShareContact()}
          element={<ShareContactPage />}
        />
        <Route path={ROUTES.settings()} element={<Settings />} />
        <Route path={ROUTES.discussions()} element={<Discussions />} />

        {/* Default redirects */}
        <Route
          path={ROUTES.default()}
          element={<Navigate to={ROUTES.discussions()} replace />}
        />
        <Route
          path="*"
          element={<Navigate to={ROUTES.discussions()} replace />}
        />
      </Routes>
    </MainLayout>
  );
};
