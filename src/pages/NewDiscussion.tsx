import { useNavigate } from 'react-router-dom';

import { useAccountStore } from '../stores/accountStore';
import Button from '../components/ui/Button';
import { useEffect, useState } from 'react';
import { Contact, db } from '../db';
import ContactAvatar from '../components/avatar/ContactAvatar';
import { formatUserId } from '../utils';
import PageHeader from '../components/ui/PageHeader';

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

  const handleClose = () => navigate('/');
  const onNewContact = () => navigate('/new-contact');

  const onSelectContact = async (contact: Contact) => {
    if (!userProfile?.userId) return;
    const discussion = await db.getDiscussionByOwnerAndContact(
      userProfile.userId,
      contact.userId
    );
    if (discussion && discussion.status === 'active') {
      navigate(`/discussion/${contact.userId}`);
    }
  };

  return (
    <div className="h-full px-3 py-3">
      <div className="max-w-md mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-md overflow-hidden">
          {/* Card header */}
          <PageHeader title="New discussion" onBack={handleClose} />

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
                  <svg
                    className="w-5 h-5 text-gray-700 dark:text-gray-200"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
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
                  <svg
                    className="w-5 h-5 text-gray-700 dark:text-gray-200"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    />
                  </svg>
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
                  <svg
                    className="w-5 h-5 text-gray-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
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
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {formatUserId(contact.userId)}
                          </p>
                        </div>
                      </Button>
                      <button
                        onClick={() => navigate(`/contact/${contact.userId}`)}
                        className="shrink-0 p-3 hover:bg-accent/50 transition-colors h-auto flex items-center justify-center"
                        title="Edit contact"
                        aria-label="Edit contact"
                      >
                        <svg
                          className="w-5 h-5 text-gray-500 dark:text-gray-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                          />
                        </svg>
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
