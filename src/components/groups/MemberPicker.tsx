import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'react-feather';
import type { Contact } from '@massalabs/gossip-sdk';
import SearchBar from '../ui/SearchBar';
import UserIdDisplay from '../ui/UserIdDisplay';
import ContactAvatar from '../avatar/ContactAvatar';
import SafeName from './SafeName';
import { safeName } from '../../utils/groupName';

interface MemberPickerProps {
  /** The contacts that can be picked, in the order shown. */
  contacts: Contact[];
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  /** Shown when no contact can be picked at all. */
  emptyText: string;
}

/**
 * The member picker of a chat, the same when creating one and when adding
 * members to it (Lucas's screens 01 and 10): a search, then each contact with
 * its avatar, name, user ID and a round check.
 */
const MemberPicker: React.FC<MemberPickerProps> = ({
  contacts,
  selected,
  onToggle,
  emptyText,
}) => {
  const { t } = useTranslation('groups');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      c =>
        safeName(c.name).toLowerCase().includes(q) ||
        c.userId.toLowerCase().includes(q)
    );
  }, [contacts, query]);

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">
            {t('details.add_members')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('new_group.selected', { count: selected.size })}
          </p>
        </div>
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder={t('discussions:new_discussion.search_contacts')}
          aria-label={t('discussions:new_discussion.search_contacts')}
        />
      </div>
      {contacts.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="max-h-[50vh] overflow-y-auto">
          {shown.map(contact => {
            const isSelected = selected.has(contact.userId);
            return (
              <li key={contact.userId}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={safeName(contact.name)}
                  onClick={() => onToggle(contact.userId)}
                  className="hover-fill w-full px-4 py-3 flex items-center gap-3 text-left border-b border-border last:border-b-0"
                >
                  <ContactAvatar contact={contact} size={10} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      <SafeName name={contact.name} />
                    </p>
                    <UserIdDisplay
                      userId={contact.userId}
                      textClassName="text-muted-foreground"
                    />
                  </div>
                  <span
                    className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
                      isSelected
                        ? 'bg-primary border-primary text-primary-foreground'
                        : 'border-border'
                    }`}
                  >
                    {isSelected && <Check className="w-4 h-4" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default MemberPicker;
