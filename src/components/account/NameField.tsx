import React from 'react';
import FormInput from '../ui/FormInput';

interface NameFieldProps {
  name: string;
  onChange: (value: string) => void;
  error: string | null;
}

const NameField: React.FC<NameFieldProps> = ({ name, onChange, error }) => {
  return (
    <FormInput
      id="contact-name"
      label="Name"
      value={name}
      onChange={onChange}
      placeholder="Contact name"
      error={error}
    />
  );
};

export default NameField;
