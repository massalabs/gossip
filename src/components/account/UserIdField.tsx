import React from 'react';
import FormInput from '../ui/FormInput';

interface UserIdFieldProps {
  userId: string;
  onChange: (value: string) => void;
  error: string | null;
  isFetching: boolean;
}

const UserIdField: React.FC<UserIdFieldProps> = ({
  userId,
  onChange,
  error,
  isFetching,
}) => {
  return (
    <FormInput
      id="contact-user-id"
      label="User ID"
      value={userId}
      onChange={onChange}
      placeholder="gossip..."
      error={error}
      isLoading={isFetching}
      loadingLabel="Loading public key"
      helperText="User ID is a unique 32-byte identifier"
      className="pr-12"
    />
  );
};

export default UserIdField;
