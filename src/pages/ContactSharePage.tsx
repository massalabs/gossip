import React, { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ShareContact from '../components/settings/ShareContact';
import { useDiscussionStore } from '../stores/discussionStore';
import { ROUTES } from '../constants/routes';
import { UserPublicKeys } from '@massalabs/gossip-sdk';

const ContactSharePage: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const contact = useDiscussionStore(s =>
    s.contacts.find(c => c.userId === userId)
  );

  const contactPublicKeys = useMemo(() => {
    if (!contact?.publicKeys) return null;
    try {
      return UserPublicKeys.from_bytes(contact.publicKeys);
    } catch (error) {
      console.error('Failed to decode contact public keys', error);
      return null;
    }
  }, [contact]);

  const handleBack = () => {
    if (userId) {
      navigate(ROUTES.contact({ userId }));
    } else {
      navigate(-1);
    }
  };

  if (!contact) {
    // Redirect to discussions if contact not found
    navigate(ROUTES.discussions());
    return null;
  }

  if (!contactPublicKeys) {
    // Redirect back to contact if public keys not available
    handleBack();
    return null;
  }

  return (
    <ShareContact
      onBack={handleBack}
      userId={contact.userId}
      userName={contact.name}
      publicKey={contactPublicKeys}
    />
  );
};

export default ContactSharePage;
