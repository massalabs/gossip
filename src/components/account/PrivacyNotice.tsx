import React from 'react';

const PrivacyNotice: React.FC = () => {
  return (
    <div className="mt-2 p-3 bg-muted/30 border border-border rounded-lg">
      <div className="flex items-start gap-2">
        <svg
          className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
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
