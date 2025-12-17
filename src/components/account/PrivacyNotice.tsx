import React from 'react';
import { Info } from 'react-feather';

const PrivacyNotice: React.FC = () => {
  return (
    <div className="mt-2 p-3 bg-muted/30 border border-border rounded-lg">
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-xs font-medium text-foreground mb-1">
            Privacy notice
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            This message is sent with your contact request announcement and has{' '}
            <span className="font-medium text-foreground">reduced privacy</span>{' '}
            compared to regular Gossip messages. Unlike regular messages, if
            your keys are compromised in the future, this message could be
            decrypted. Use it for introductions or context, but avoid sharing
            sensitive information. Send private details through regular messages
            after the contact accepts your request.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PrivacyNotice;
