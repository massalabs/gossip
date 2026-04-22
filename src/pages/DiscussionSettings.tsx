import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDiscussionStore } from '../stores/discussionStore';
import ContactAvatar from '../components/avatar/ContactAvatar';
import ContactNameModal from '../components/ui/ContactNameModal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import PageLayout from '../components/ui/Layout/PageLayout';
import {
  Check,
  Edit2,
  ChevronRight,
  RotateCw,
  Bell,
  BellOff,
} from 'react-feather';
import { ROUTES } from '../constants/routes';
import { useManualRenewDiscussion } from '../hooks/useManualRenew';
import type { Contact } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../hooks/useGossipSdk';

const DiscussionSettings: React.FC = () => {
  const { t } = useTranslation('discussions');
  const { discussionId } = useParams();
  const navigate = useNavigate();
  const gossip = useGossipSdk();

  const discussions = useDiscussionStore(s => s.discussions);
  const contacts = useDiscussionStore(s => s.contacts);
  const patchDiscussion = useDiscussionStore(s => s.patchDiscussion);
  const manualRenewDiscussion = useManualRenewDiscussion();

  const discussion = useMemo(() => {
    if (!discussionId) return undefined;
    const id = parseInt(discussionId, 10);
    return discussions.find(d => d.id === id);
  }, [discussionId, discussions]);

  // For now, we have a single contact per discussion
  // This array structure supports future group discussions
  const participants: Contact[] = useMemo(() => {
    if (!discussion) return [];
    const contact = contacts.find(c => c.userId === discussion.contactUserId);
    return contact ? [contact] : [];
  }, [discussion, contacts]);

  // Display name logic: customName takes priority over contact name
  const displayName = useMemo(() => {
    if (discussion?.customName) return discussion.customName;
    if (participants.length === 1) return participants[0].name;
    if (participants.length > 1) {
      return participants.map(p => p.name).join(', ');
    }
    return 'Unknown';
  }, [discussion?.customName, participants]);

  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
  const [proposedName, setProposedName] = useState(displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);
  const [reconnectSuccess, setReconnectSuccess] = useState(false);
  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // Sync proposed name when display name changes
  useEffect(() => {
    setProposedName(displayName);
  }, [displayName]);

  // Hide success check after 3 seconds
  useEffect(() => {
    if (showSuccessCheck) {
      const timer = setTimeout(() => {
        setShowSuccessCheck(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [showSuccessCheck]);

  // Cleanup reconnect timeout on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  const handleOpenEditName = useCallback(() => {
    setProposedName(discussion?.customName || '');
    setNameError(null);
    setIsNameModalOpen(true);
  }, [discussion?.customName]);

  const handleSaveName = useCallback(
    async (name?: string) => {
      if (!discussion?.id) return;

      const result = await gossip.discussions.updateName(discussion.id, name);
      if (!result.success) {
        setNameError(result.message);
        return;
      }

      setIsNameModalOpen(false);
      setShowSuccessCheck(true);
    },
    [gossip, discussion?.id]
  );

  const RETENTION_OPTIONS = useMemo(
    () => [
      { labelKey: 'settings.auto_delete_off', value: null as number | null },
      { labelKey: 'settings.auto_delete_5m', value: 300 },
      { labelKey: 'settings.auto_delete_1h', value: 3600 },
      { labelKey: 'settings.auto_delete_8h', value: 28800 },
      { labelKey: 'settings.auto_delete_1d', value: 86400 },
      { labelKey: 'settings.auto_delete_1w', value: 604800 },
      { labelKey: 'settings.auto_delete_1mo', value: 2592000 },
    ],
    []
  );

  const currentRetention = discussion?.messageRetentionDuration ?? null;

  const retentionLabel = useMemo(() => {
    const option = RETENTION_OPTIONS.find(o => o.value === currentRetention);
    return option ? t(option.labelKey) : t('settings.auto_delete_off');
  }, [currentRetention, t, RETENTION_OPTIONS]);

  const handleSelectRetention = useCallback(
    async (value: number | null) => {
      if (!discussion?.id || !discussion?.contactUserId) return;
      // Optimistically update the store so the label is instant here and in
      // the discussion header when navigating back.
      patchDiscussion(discussion.id, {
        messageRetentionDuration: value,
        retentionPolicySetAt: Date.now(),
      });
      setIsRetentionModalOpen(false);
      await gossip.discussions.setRetentionPolicy(
        discussion.contactUserId,
        value
      );
    },
    [gossip, discussion?.id, discussion?.contactUserId, patchDiscussion]
  );

  const handleToggleMute = useCallback(async () => {
    if (!discussion?.id) return;
    const newMuted = !discussion.mutedNotifications;
    patchDiscussion(discussion.id, { mutedNotifications: newMuted });
    await gossip.discussions.setMuted(discussion.id, newMuted);
  }, [gossip, discussion?.id, discussion?.mutedNotifications, patchDiscussion]);

  const handleNavigateToContact = useCallback(
    (contact: Contact) => {
      navigate(ROUTES.contact({ userId: contact.userId }));
    },
    [navigate]
  );

  const handleResetConnection = useCallback(async () => {
    if (!discussion?.contactUserId) return;

    try {
      await manualRenewDiscussion(discussion.contactUserId);
      setReconnectSuccess(true);

      // Clear existing timeout if any
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      // Reset feedback after 2 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        setReconnectSuccess(false);
        reconnectTimeoutRef.current = null;
      }, 2000);
    } catch (error) {
      console.error('Failed to reset connection:', error);
    }
  }, [discussion?.contactUserId, manualRenewDiscussion]);

  if (!discussion) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">
            {t('settings.loading')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader title={t('settings.title')} onBack={() => navigate(-1)} />
      }
      className="app-max-w mx-auto"
      contentClassName="pt-3 px-4 pb-4 pb-safe-b"
    >
      {/* Discussion Name Section */}
      <div className="mb-4">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {t('settings.name_section')}
        </h2>
        <div className="bg-background border border-border rounded-xl p-3">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">
                {displayName}
              </p>
            </div>
            <div className="flex items-center gap-2 ml-3">
              {showSuccessCheck && (
                <Check className="w-4 h-4 text-success transition-opacity duration-200" />
              )}
              <Button
                onClick={handleOpenEditName}
                variant="ghost"
                size="custom"
                className="p-2 hover:bg-muted rounded-lg transition-colors"
                title={t('settings.edit_name')}
              >
                <Edit2 className="w-4 h-4 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Reset Connection Section */}
      <div className="mb-4">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {t('settings.reset_connection')}
        </h2>
        <div className="bg-background border border-border rounded-xl p-3">
          <p className="text-xs text-muted-foreground mb-2 leading-snug">
            {t('settings.reset_description')}
          </p>
          <Button
            onClick={handleResetConnection}
            variant="secondary"
            size="custom"
            className="w-full h-10 text-sm"
          >
            {reconnectSuccess ? (
              <Check className="w-4 h-4 mr-2" />
            ) : (
              <RotateCw className="w-4 h-4 mr-2" />
            )}
            {reconnectSuccess
              ? t('settings.reconnected')
              : t('settings.reset_connection')}
          </Button>
        </div>
      </div>

      {/* Mute Notifications Section */}
      <div className="mb-4">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {t('settings.notifications')}
        </h2>
        <div className="bg-background border border-border rounded-xl p-2">
          <button
            onClick={handleToggleMute}
            className="w-full flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted rounded-lg px-2 py-2 transition-colors"
          >
            <div className="flex items-center gap-3">
              {discussion.mutedNotifications ? (
                <BellOff className="w-4 h-4 text-muted-foreground" />
              ) : (
                <Bell className="w-4 h-4 text-muted-foreground" />
              )}
              <span>
                {discussion.mutedNotifications
                  ? t('settings.unmute_notifications')
                  : t('settings.mute_notifications')}
              </span>
            </div>
            {discussion.mutedNotifications && (
              <span className="text-xs text-muted-foreground">
                {t('settings.muted')}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Auto-delete Section */}
      <div className="mb-4">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {t('settings.auto_delete')}
        </h2>
        <div className="bg-background border border-border rounded-xl p-3">
          <p className="text-xs text-muted-foreground mb-2 leading-snug">
            {t('settings.auto_delete_description')}
          </p>
          <button
            onClick={() => setIsRetentionModalOpen(true)}
            className="w-full flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted rounded-lg px-2 py-2 transition-colors"
          >
            <span>{t('settings.auto_delete_current')}</span>
            <span className="text-accent-soft-foreground">
              {retentionLabel}
            </span>
          </button>
        </div>
      </div>

      {/* Retention picker modal */}
      {isRetentionModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
          onClick={() => setIsRetentionModalOpen(false)}
        >
          <div
            className="bg-background w-full max-w-md rounded-t-2xl p-6 pb-8"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-foreground mb-4">
              {t('settings.auto_delete')}
            </h3>
            <div className="flex flex-col gap-1">
              {RETENTION_OPTIONS.map(option => (
                <button
                  key={String(option.value)}
                  onClick={() => handleSelectRetention(option.value)}
                  className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors ${
                    currentRetention === option.value
                      ? 'bg-accent-soft text-accent-soft-foreground font-medium'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Participants Section */}
      <div>
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {t('settings.participants')}
        </h2>
        <div className="bg-background border border-border rounded-xl divide-y divide-border">
          {participants.map(contact => (
            <button
              key={contact.userId}
              onClick={() => handleNavigateToContact(contact)}
              className="hover-fill w-full flex items-center gap-2.5 p-3 first:rounded-t-xl last:rounded-b-xl"
            >
              <ContactAvatar contact={contact} size={10} />
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium text-foreground truncate">
                  {contact.name}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </button>
          ))}
          {participants.length === 0 && (
            <div className="p-3 text-center text-sm text-muted-foreground">
              {t('settings.no_participants')}
            </div>
          )}
        </div>
      </div>

      <ContactNameModal
        isOpen={isNameModalOpen}
        onClose={() => setIsNameModalOpen(false)}
        title={t('settings.edit_name')}
        initialName={proposedName}
        confirmLabel={t('common:save')}
        allowEmpty
        error={nameError}
        onConfirm={async name => {
          await handleSaveName(name);
        }}
      />
    </PageLayout>
  );
};

export default DiscussionSettings;
