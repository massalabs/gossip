import React from 'react';
import { PrivacyGraphic } from '../ui/PrivacyGraphic';

const EmptyDiscussions: React.FC = () => {
  return (
    <div className="py-8 text-center h-full flex flex-col justify-center items-center">
      <div className="flex justify-center">
        <PrivacyGraphic size={60} />
      </div>
      <p className="text-sm text-muted-foreground mb-4 font-bold">
        No discussions yet
      </p>
      <p className="text-xs text-muted-foreground">
        Start a discussion by tapping the <span className="font-bold">+</span>{' '}
        button
      </p>
    </div>
  );
};

export default EmptyDiscussions;
