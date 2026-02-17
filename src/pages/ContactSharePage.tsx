import React, { useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
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
    navigate(-1);
  };

  if (!contact) {
    return <Navigate to={ROUTES.discussions()} replace />;
  }

  if (!contactPublicKeys) {
    return (
      <Navigate
        to={userId ? ROUTES.contact({ userId }) : ROUTES.discussions()}
        replace
      />
    );
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
