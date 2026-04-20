import React from 'react';
import { Route, Navigate } from 'react-router-dom';
import Discussions from '../pages/Discussions';
import Discussion from '../pages/Discussion';
import NewDiscussion from '../pages/NewDiscussion';
import NewContact from '../pages/NewContact';
import Settings from '../pages/Settings';
import { InvitePage } from '../pages/InvitePage';
import Contact from '../pages/Contact';
import ContactSharePage from '../pages/ContactSharePage';
import SelfDiscussion from '../pages/SelfDiscussion';
import DiscussionSettings from '../pages/DiscussionSettings';
import SecuritySettings from '../pages/settings/SecuritySettings';
import NotificationsSettings from '../pages/settings/NotificationsSettings';
import AppearanceSettings from '../pages/settings/AppearanceSettings';
import LanguageSettings from '../pages/settings/LanguageSettings';
import AboutSettings from '../pages/settings/AboutSettings';
import DebugSettings from '../pages/settings/DebugSettings';
import AccountBackupPage from '../pages/settings/AccountBackupPage';
import QRCodeSwitcher from '../pages/settings/QRCodeSwitcher';
import Web3Settings from '../pages/settings/Web3Settings';
import PrivacySettings from '../pages/settings/PrivacySettings';
import { usePendingDeepLink } from '../hooks/usePendingDeepLink';
import { usePendingSharedContent } from '../hooks/usePendingSharedContent';
import { ROUTES } from '../constants/routes';
import MainLayout from '../components/ui/Layout/MainLayout';
import AnimatedRoutes from '../components/ui/AnimatedRoutes';

/**
 * Routes accessible when user is authenticated.
 *
 * - AnimatedRoutes provides cross-fade transitions between pages
 * - All pages are eagerly imported: bundle is local (Capacitor), chunks are
 *   small (~60 KB combined), and lazy loading added perceptible click-to-render
 *   latency without a meaningful startup-size win.
 * - MainLayout handles bottom nav visibility (configured in pageConfig.ts)
 */
export const AuthenticatedRoutes: React.FC = () => {
  usePendingDeepLink();
  usePendingSharedContent();

  return (
    <MainLayout>
      <AnimatedRoutes>
        <Route path={ROUTES.discussions()} element={<Discussions />} />
        <Route path={ROUTES.discussion()} element={<Discussion />} />
        <Route path={ROUTES.newDiscussion()} element={<NewDiscussion />} />
        <Route path={ROUTES.newContact()} element={<NewContact />} />
        <Route path={ROUTES.settings()} element={<Settings />} />
        <Route path={ROUTES.invite()} element={<InvitePage />} />
        <Route path={ROUTES.contact()} element={<Contact />} />
        <Route path={ROUTES.contactShare()} element={<ContactSharePage />} />
        <Route path={ROUTES.selfDiscussion()} element={<SelfDiscussion />} />
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
        <Route
          path={ROUTES.settingsLanguage()}
          element={<LanguageSettings />}
        />
        <Route path={ROUTES.settingsAbout()} element={<AboutSettings />} />
        <Route path={ROUTES.settingsDebug()} element={<DebugSettings />} />
        <Route
          path={ROUTES.settingsAccountBackup()}
          element={<AccountBackupPage />}
        />
        <Route
          path={ROUTES.settingsShareContact()}
          element={<QRCodeSwitcher />}
        />
        <Route path={ROUTES.settingsWeb3()} element={<Web3Settings />} />
        <Route path={ROUTES.settingsPrivacy()} element={<PrivacySettings />} />

        {/* Default redirects */}
        <Route
          path={ROUTES.default()}
          element={<Navigate to={ROUTES.discussions()} replace />}
        />
        <Route
          path="*"
          element={<Navigate to={ROUTES.discussions()} replace />}
        />
      </AnimatedRoutes>
    </MainLayout>
  );
};
