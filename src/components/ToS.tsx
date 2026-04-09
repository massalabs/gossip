import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import tosContent from '../../TERMS_OF_SERVICE.md?raw';

interface ToSProps {
  onHasScrolledBottom?: () => void;
}

const ToS: React.FC<ToSProps> = ({ onHasScrolledBottom }) => {
  const { t } = useTranslation('onboarding');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40;
    if (atBottom && !hasScrolledToBottom) {
      setHasScrolledToBottom(true);
      if (onHasScrolledBottom) {
        onHasScrolledBottom();
      }
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <h1 className="text-2xl font-bold text-foreground mb-4 shrink-0">
        {t('tos.title', 'Terms of Service')}
      </h1>
      {/* Scrollable ToS content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed"
      >
        {tosContent}
      </div>
    </div>
  );
};

export default ToS;
