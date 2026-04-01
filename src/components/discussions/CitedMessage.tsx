import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'react-feather';
import { parseLinks } from '../../utils/linkUtils';

interface CitedMessageProps {
  isOutgoing: boolean;
  isNotFound: boolean;
  isLoading: boolean;
  content: string | undefined;
  parsedLinks: ReturnType<typeof parseLinks>;
  canNavigate: boolean;
  label?: string;
  fallbackContent?: string;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onLinkClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  linkAriaLabel: (content: string) => string;
}

const CitedMessage: React.FC<CitedMessageProps> = ({
  isOutgoing,
  isNotFound,
  isLoading,
  content,
  parsedLinks,
  canNavigate,
  label,
  fallbackContent,
  onClick,
  onKeyDown,
  onLinkClick,
  linkAriaLabel,
}) => {
  const { t } = useTranslation('discussions');
  const textColor = isOutgoing
    ? 'text-accent-foreground/80'
    : 'text-muted-foreground/80';

  return (
    <div
      className={`mb-2 pb-2 border-l-2 pl-2 ${
        isOutgoing ? 'border-accent-foreground/30' : 'border-card-foreground/30'
      } ${isNotFound ? 'border-destructive/50' : ''} ${
        canNavigate
          ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-r transition-colors active:scale-[0.98]'
          : ''
      }`}
      {...(canNavigate
        ? {
            onClick,
            onKeyDown,
            tabIndex: 0,
            role: 'button' as const,
            'aria-label': t('message_item.jump_to_original'),
          }
        : {})}
    >
      {isNotFound && (
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
      {label && (
        <p className={`text-[11px] font-medium mb-0.5 ${textColor}`}>{label}</p>
      )}
      <p
        className={`text-xs truncate ${textColor} ${isNotFound ? 'italic opacity-70' : ''}`}
      >
        {isLoading
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
            : content || fallbackContent || t('message_item.original_message')}
      </p>
    </div>
  );
};

export default CitedMessage;
