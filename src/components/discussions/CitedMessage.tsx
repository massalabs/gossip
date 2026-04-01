import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'react-feather';
import type { parseLinks } from '../../utils/linkUtils';

export interface CitedMessageOriginal {
  originalMessage: { content: string } | null;
  isLoadingOriginal: boolean;
  originalNotFound: boolean;
  parsedReplyLinks: ReturnType<typeof parseLinks>;
  parsedForwardLinks: ReturnType<typeof parseLinks>;
  canNavigateToForwarded: boolean;
  handleReplyContextClick: (e: React.MouseEvent) => void;
  handleReplyContextKeyDown: (e: React.KeyboardEvent) => void;
}

interface CitedMessageProps {
  isOutgoing: boolean;
  original: CitedMessageOriginal;
  variant: 'reply' | 'forward';
  fallbackContent?: string;
  onLinkClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  linkAriaLabel: (content: string) => string;
}

const CitedMessage: React.FC<CitedMessageProps> = ({
  isOutgoing,
  original,
  variant,
  fallbackContent,
  onLinkClick,
  linkAriaLabel,
}) => {
  const { t } = useTranslation('discussions');
  const textColor = isOutgoing
    ? 'text-accent-foreground/80'
    : 'text-muted-foreground/80';

  const isReply = variant === 'reply';
  const parsedLinks = isReply
    ? original.parsedReplyLinks
    : original.parsedForwardLinks;
  const canNavigate = isReply
    ? !!original.handleReplyContextClick
    : original.canNavigateToForwarded;
  const showNotFound = isReply && original.originalNotFound;

  return (
    <div
      className={`mb-2 pb-2 border-l-2 pl-2 ${
        isOutgoing ? 'border-accent-foreground/30' : 'border-card-foreground/30'
      } ${showNotFound ? 'border-destructive/50' : ''} ${
        canNavigate
          ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98]'
          : ''
      }`}
      {...(canNavigate
        ? {
            onClick: original.handleReplyContextClick,
            onKeyDown: original.handleReplyContextKeyDown,
            tabIndex: 0,
            role: 'button' as const,
            'aria-label': t('message_item.jump_to_original'),
          }
        : {})}
    >
      {showNotFound && (
        <div className="flex items-center gap-1 mb-2">
          <span
            className="inline-flex items-center gap-1"
            title={t('message_item.original_not_found_title')}
          >
            <AlertTriangle
              className="w-3.5 h-3.5 text-destructive shrink-0"
              aria-hidden="true"
            />
            <span className="text-xs text-destructive md:hidden">
              {t('message_item.original_not_found_short')}
            </span>
          </span>
        </div>
      )}
      {!isReply && (
        <p className={`text-[11px] font-medium mb-0.5 ${textColor}`}>
          {t('message_item.forwarded_message')}
        </p>
      )}
      <p
        className={`text-xs truncate ${textColor} ${showNotFound ? 'italic opacity-70' : ''}`}
      >
        {original.isLoadingOriginal
          ? t('common:loading')
          : parsedLinks.length > 0
            ? parsedLinks.map((segment, index) =>
                segment.type === 'link' ? (
                  <a
                    key={index}
                    href={segment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onLinkClick}
                    aria-label={linkAriaLabel(segment.content)}
                    className="underline hover:opacity-80 transition-opacity break-all cursor-pointer"
                    style={{
                      textDecorationColor: 'currentColor',
                      textDecorationThickness: '1px',
                    }}
                  >
                    {segment.content}
                  </a>
                ) : (
                  <span key={index}>{segment.content}</span>
                )
              )
            : original.originalMessage?.content ||
              fallbackContent ||
              t('message_item.original_message')}
      </p>
    </div>
  );
};

export default CitedMessage;
