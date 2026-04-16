import { useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { Edit2, Plus, Users, User } from 'react-feather';
import { useAccountStore } from '../stores/accountStore';
import Button from '../components/ui/Button';
import { useEffect, useMemo, useState } from 'react';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../hooks/useGossipSdk';
import ContactAvatar from '../components/avatar/ContactAvatar';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import PageHeader from '../components/ui/PageHeader';
import PageLayout from '../components/ui/Layout/PageLayout';
import { ROUTES } from '../constants/routes';
import SearchBar from '../components/ui/SearchBar';
import ConnectionBanner from '../components/ui/ConnectionBanner';

/* TODO: contact list is implemented using corresponding discussions.
This is a temporary solution to avoid duplicating the contact list code.
In future we should decouple contact from discussion.
*/
const NewDiscussion: React.FC = () => {
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const { userProfile } = useAccountStore();

  useEffect(() => {
    let isMounted = true;

    const loadContacts = async () => {
      try {
        setIsLoading(true);
        const list = userProfile?.userId
          ? await gossip.contacts
              .list()
              .then(arr => arr.sort((a, b) => a.name.localeCompare(b.name)))
          : [];
        if (isMounted) setContacts(list);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadContacts();
    return () => {
      isMounted = false;
    };
  }, [userProfile?.userId, gossip]);

  const handleClose = () => navigate(ROUTES.default());
  const onNewContact = () => navigate(ROUTES.newContact());

  const filteredContacts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter(contact => {
      const name = contact.name.toLowerCase();
      const userId = contact.userId.toLowerCase();
      return name.includes(query) || userId.includes(query);
    });
  }, [contacts, searchQuery]);

  const onSelectContact = async (contact: Contact) => {
    if (!userProfile?.userId) return;
    const discussion = await gossip.discussions.get(contact.userId);
    if (
      discussion &&
      gossip.discussions.getStatus(contact.userId) === SessionStatus.Active
    ) {
      navigate(ROUTES.discussion({ userId: contact.userId }));
    }
  };

  return (
    <PageLayout
      header={
        <PageHeader title={t('new_discussion.title')} onBack={handleClose} />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-4"
    >
      <ConnectionBanner />
      {/* Primary actions */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <Button
          onClick={onNewContact}
          variant="outline"
          size="custom"
          className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
        >
          <Plus className="mr-4" />
          <span className="text-base font-normal flex-1 text-left">
            {t('new_discussion.new_contact')}
          </span>
        </Button>
        <Button
          onClick={() => {}}
          variant="outline"
          size="custom"
          disabled
          title={t('new_discussion.coming_soon')}
          className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 opacity-60 cursor-not-allowed"
        >
          <Users className="mr-4" />
          <span className="text-base font-normal flex-1 text-left">
            {t('new_discussion.new_group')}
          </span>
        </Button>
      </div>

      {/* Contacts card */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="border-b border-border px-4 py-3 space-y-3">
          <p className="text-sm font-medium text-foreground">
            {t('new_discussion.contacts')}
          </p>
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('new_discussion.search_contacts')}
            className="mt-1"
            aria-label={t('new_discussion.search_contacts')}
          />
        </div>
        <div>
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground">
              {t('new_discussion.loading_contacts')}
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <div className="mx-auto mb-3 w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <User className="w-5 h-5 text-muted-foreground" />
              </div>
              <p className="text-sm text-foreground">
                {t('new_discussion.no_contacts')}
              </p>
              <p className="text-xs mt-1">
                <Trans
                  i18nKey="new_discussion.no_contacts_hint"
                  ns="discussions"
                  components={{ strong: <strong /> }}
                />
              </p>
            </div>
          ) : filteredContacts.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              <p className="text-sm">{t('new_discussion.no_search_results')}</p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {filteredContacts.map(contact => {
                return (
                  <li key={contact.userId} className="flex items-stretch">
                    <Button
                      onClick={() => onSelectContact(contact)}
                      variant="ghost"
                      size="custom"
                      className="hover-fill flex-1 px-4 py-3 flex items-center gap-3 text-left rounded-none border-0 border-b border-border last:border-b-0"
                    >
                      <ContactAvatar contact={contact} size={10} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {contact.name}
                        </p>
                        <UserIdDisplay
                          userId={contact.userId}
                          textClassName="text-muted-foreground"
                        />
                      </div>
                    </Button>
                    <button
                      onClick={() =>
                        navigate(ROUTES.contact({ userId: contact.userId }))
                      }
                      className="shrink-0 p-3 hover:bg-accent/50 transition-colors h-auto flex items-center justify-center border-l border-border"
                      title={t('new_discussion.edit_contact')}
                      aria-label={t('new_discussion.edit_contact')}
                    >
                      <Edit2 className="w-5 h-5 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </PageLayout>
  );
};

export default NewDiscussion;
