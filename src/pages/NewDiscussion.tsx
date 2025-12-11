import { useNavigate } from 'react-router-dom';
import { Edit2, Plus, Users, User } from 'react-feather';
import { useAccountStore } from '../stores/accountStore';
import Button from '../components/ui/Button';
import { useEffect, useState } from 'react';
import { Contact, DiscussionStatus, db } from '../db';
import ContactAvatar from '../components/avatar/ContactAvatar';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import PageHeader from '../components/ui/PageHeader';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import { ROUTES } from '../constants/routes';

/* TODO: contact list is implemented using corresponding discussions.
This is a temporary solution to avoid duplicating the contact list code.
In future we should decouple contact from discussion.
*/
const NewDiscussion: React.FC = () => {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const { userProfile } = useAccountStore();

  useEffect(() => {
    let isMounted = true;

    const loadContacts = async () => {
      try {
        setIsLoading(true);
        const list = userProfile?.userId
          ? await db
              .getContactsByOwner(userProfile.userId)
              .then(arr => arr.sort((a, b) => a.name.localeCompare(b.name)))
          : [];
        if (isMounted) {
          setContacts(list);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadContacts();
    return () => {
      isMounted = false;
    };
  }, [userProfile?.userId]);

  const handleClose = () => navigate(ROUTES.default());
  const onNewContact = () => navigate(ROUTES.newContact());

  const onSelectContact = async (contact: Contact) => {
    if (!userProfile?.userId) return;
    const discussion = await db.getDiscussionByOwnerAndContact(
      userProfile.userId,
      contact.userId
    );
    if (discussion && discussion.status === DiscussionStatus.ACTIVE) {
      navigate(ROUTES.discussion({ userId: contact.userId }));
    }
  };

  return (
    <div className="h-full px-3 py-3">
      <div className="app-max-w mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-md overflow-hidden">
          {/* Card header */}
          <HeaderWrapper>
            <PageHeader title="New discussion" onBack={handleClose} />
          </HeaderWrapper>

          {/* Actions: New group / New contact */}
          <div className="px-4 pt-4">
            <div className="space-y-3">
              <Button
                onClick={() => {}}
                variant="ghost"
                size="custom"
                disabled={true}
                title="Coming soon"
                className="w-full flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3 text-left opacity-50 cursor-not-allowed"
              >
                <span className="inline-flex w-6 h-6 items-center justify-center">
                  <Users className="w-5 h-5 text-gray-700 dark:text-gray-200" />
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  New group
                </span>
              </Button>

              <Button
                onClick={onNewContact}
                variant="ghost"
                size="custom"
                className="w-full flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-left"
              >
                <span className="inline-flex w-6 h-6 items-center justify-center">
                  <Plus className="w-5 h-5 text-gray-700 dark:text-gray-200" />
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  New contact
                </span>
              </Button>
            </div>
          </div>

          {/* Contacts list */}
          <div className="mt-4 border-t border-gray-200 dark:border-gray-700">
            {isLoading ? (
              <div className="p-6 text-center text-gray-500 dark:text-gray-400">
                Loading contacts…
              </div>
            ) : contacts.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <div className="mx-auto mb-3 w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                  <User className="w-5 h-5 text-gray-400" />
                </div>
                <p className="text-sm">No contacts yet</p>
                <p className="text-xs mt-1">Tap "New contact" to add one</p>
              </div>
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto">
                {contacts.map(contact => {
                  return (
                    <li key={contact.userId} className="flex items-stretch">
                      <Button
                        onClick={() => onSelectContact(contact)}
                        variant="ghost"
                        size="custom"
                        className="flex-1 px-4 py-3 flex items-center gap-3 text-left hover:bg-accent/50"
                      >
                        <ContactAvatar contact={contact} size={10} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                            {contact.name}
                          </p>
                          <UserIdDisplay
                            userId={contact.userId}
                            textClassName="text-gray-500 dark:text-gray-400"
                          />
                        </div>
                      </Button>
                      <button
                        onClick={() =>
                          navigate(ROUTES.contact({ userId: contact.userId }))
                        }
                        className="shrink-0 p-3 hover:bg-accent/50 transition-colors h-auto flex items-center justify-center"
                        title="Edit contact"
                        aria-label="Edit contact"
                      >
                        <Edit2 className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewDiscussion;
