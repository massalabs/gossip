import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DEFAULT_EMOJIS } from './constants';

export interface MessageContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
}

interface MessageContextMenuProps {
  items: MessageContextMenuItem[];
  isOpen: boolean;
  onClose: () => void;
  isOutgoing: boolean;
  reactions?: ReactionGroup[];
  onSelectEmoji?: (emoji: string) => void;
  onOpenEmojiPicker?: () => void;
}

const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  items,
  isOpen,
  onClose,
  reactions,
  onSelectEmoji,
  onOpenEmojiPicker,
}) => {
  const { t } = useTranslation('discussions');
  const [touchReady, setTouchReady] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => setTouchReady(true), 120);
      return () => clearTimeout(timer);
    }
    setTouchReady(false);
  }, [isOpen]);

  // Dismiss on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed left-0 right-0 top-0 z-1000 flex items-center justify-center"
      style={{ height: 'var(--available-height, 100dvh)' }}
      onClick={e => e.stopPropagation()}
    >
      {/* Backdrop — dims screen */}
      <div
        className={`absolute inset-0 bg-black/20 dark:bg-black/40 animate-backdrop-fade-in ${touchReady ? '' : 'pointer-events-none'}`}
        style={{ height: '100%' }}
        onClick={onClose}
        data-testid="context-menu-backdrop"
      />

      {/* Centered menu */}
      <div
        className="flex flex-col items-center gap-1.5 pointer-events-none animate-context-menu-in px-6"
        style={{ '--menu-origin': 'center center' } as React.CSSProperties}
      >
        {/* Emoji reaction bar — wider, sits above the menu */}
        {(reactions || onOpenEmojiPicker) && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-card border border-border rounded-full shadow-xl pointer-events-auto">
            {DEFAULT_EMOJIS.map(emoji => {
              const match = reactions?.find(r => r.emoji === emoji);
              const isMine = !!match?.myReactionId;
              const count = match?.count ?? 0;
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onSelectEmoji?.(emoji);
                    onClose();
                  }}
                  className={`w-9 h-9 flex items-center justify-center text-lg rounded-full transition-colors ${
                    isMine
                      ? 'bg-accent/20 ring-1 ring-accent'
                      : 'hover:bg-muted'
                  }`}
                >
                  {emoji}
                  {count > 1 && (
                    <span className="text-[10px] ml-0.5">{count}</span>
                  )}
                </button>
              );
            })}
            {onOpenEmojiPicker && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onOpenEmojiPicker();
                }}
                className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted border border-border text-foreground text-lg leading-none"
                aria-label={t('message_item.more_emojis')}
              >
                +
              </button>
            )}
          </div>
        )}

        {/* Action menu — compact width */}
        <div
          role="menu"
          aria-label="Message actions"
          className={`min-w-[180px] bg-card border border-border rounded-lg shadow-xl overflow-hidden ${touchReady ? 'pointer-events-auto' : ''}`}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={`hover-fill w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-left ${
                item.danger ? 'text-destructive' : 'text-foreground'
              } ${index < items.length - 1 ? 'border-b border-border' : ''}`}
            >
              <span className="relative">{item.label}</span>
              {item.icon && (
                <span className="w-6 h-6 rounded-full bg-accent text-accent-foreground dark:bg-muted dark:text-accent shrink-0 flex items-center justify-center [&>svg]:w-3.5 [&>svg]:h-3.5">
                  {item.icon}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MessageContextMenu;
