import React, { Suspense, lazy } from 'react';
import { Route, Navigate } from 'react-router-dom';
import Discussions from '../pages/Discussions';
import Discussion from '../pages/Discussion';
import NewDiscussion from '../pages/NewDiscussion';
import NewContact from '../pages/NewContact';
import Settings from '../pages/Settings';
import { InvitePage } from '../pages/InvitePage';
import { usePendingDeepLink } from '../hooks/usePendingDeepLink';
import { usePendingSharedContent } from '../hooks/usePendingSharedContent';
import { ROUTES } from '../constants/routes';
import MainLayout from '../components/ui/Layout/MainLayout';
import AnimatedRoutes from '../components/ui/AnimatedRoutes';

// Lazy-loaded pages (not needed on initial render)
const Contact = lazy(() => import('../pages/Contact'));
const ContactSharePage = lazy(() => import('../pages/ContactSharePage'));
const SelfDiscussion = lazy(() => import('../pages/SelfDiscussion'));
const DiscussionSettings = lazy(() => import('../pages/DiscussionSettings'));
const SecuritySettings = lazy(
  () => import('../pages/settings/SecuritySettings')
);
const NotificationsSettings = lazy(
  () => import('../pages/settings/NotificationsSettings')
);
const AppearanceSettings = lazy(
  () => import('../pages/settings/AppearanceSettings')
);
const LanguageSettings = lazy(
  () => import('../pages/settings/LanguageSettings')
);
const AboutSettings = lazy(() => import('../pages/settings/AboutSettings'));
const DebugSettings = lazy(() => import('../pages/settings/DebugSettings'));
const AccountBackupPage = lazy(
  () => import('../pages/settings/AccountBackupPage')
);
const QRCodeSwitcher = lazy(() => import('../pages/settings/QRCodeSwitcher'));
const Web3Settings = lazy(() => import('../pages/settings/Web3Settings'));
const PrivacySettings = lazy(() => import('../pages/settings/PrivacySettings'));

/**
 * Routes accessible when user is authenticated.
 *
 * - AnimatedRoutes provides cross-fade transitions between pages
 * - Lazy-loaded pages reduce initial bundle size
 * - MainLayout handles bottom nav visibility (configured in pageConfig.ts)
 */
export const AuthenticatedRoutes: React.FC = () => {
  usePendingDeepLink();
  usePendingSharedContent();

  return (
    <MainLayout>
      <AnimatedRoutes>
        {/* Core pages (eagerly loaded) */}
        <Route path={ROUTES.discussions()} element={<Discussions />} />
        <Route path={ROUTES.discussion()} element={<Discussion />} />
        <Route path={ROUTES.newDiscussion()} element={<NewDiscussion />} />
        <Route path={ROUTES.newContact()} element={<NewContact />} />
        <Route path={ROUTES.settings()} element={<Settings />} />
        <Route path={ROUTES.invite()} element={<InvitePage />} />

        {/* Lazy-loaded pages (each wrapped in Suspense to avoid
              blanking the entire app during chunk load) */}
        <Route
          path={ROUTES.contact()}
          element={
            <Suspense fallback={null}>
              <Contact />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.contactShare()}
          element={
            <Suspense fallback={null}>
              <ContactSharePage />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.selfDiscussion()}
          element={
            <Suspense fallback={null}>
              <SelfDiscussion />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.discussionSettings()}
          element={
            <Suspense fallback={null}>
              <DiscussionSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsSecurity()}
          element={
            <Suspense fallback={null}>
              <SecuritySettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsNotifications()}
          element={
            <Suspense fallback={null}>
              <NotificationsSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsAppearance()}
          element={
            <Suspense fallback={null}>
              <AppearanceSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsLanguage()}
          element={
            <Suspense fallback={null}>
              <LanguageSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsAbout()}
          element={
            <Suspense fallback={null}>
              <AboutSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsDebug()}
          element={
            <Suspense fallback={null}>
              <DebugSettings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsAccountBackup()}
          element={
            <Suspense fallback={null}>
              <AccountBackupPage />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsShareContact()}
          element={
            <Suspense fallback={null}>
              <QRCodeSwitcher />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsWeb3()}
          element={
            <Suspense fallback={null}>
              <Web3Settings />
            </Suspense>
          }
        />
        <Route
          path={ROUTES.settingsPrivacy()}
          element={
            <Suspense fallback={null}>
              <PrivacySettings />
            </Suspense>
          }
        />

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
