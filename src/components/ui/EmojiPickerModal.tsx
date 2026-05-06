import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import EmojiPicker, {
  type EmojiClickData,
  Theme,
  EmojiStyle,
} from 'emoji-picker-react';
import { Capacitor } from '@capacitor/core';
import { useUiStore } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';

const isAndroid = Capacitor.getPlatform() === 'android';

interface EmojiPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectEmoji: (emoji: string) => void;
  title?: string;
  height?: number;
}

const EmojiPickerModal: React.FC<EmojiPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectEmoji,
  title,
  height = 300,
}) => {
  const { t } = useTranslation('discussions');
  const resolvedTheme = useUiStore(s => s.resolvedTheme);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-end justify-center">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${mounted ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />

      {/* Picker — slides up from bottom */}
      <div
        className={`relative w-full max-w-md transform transition-transform duration-300 ease-out ${mounted ? 'translate-y-0' : 'translate-y-full'}`}
        style={{
          // Override emoji-picker-react CSS variables to match app theme
          ['--epr-bg-color' as string]: 'var(--card)',
          ['--epr-category-label-bg-color' as string]: 'var(--card)',
          ['--epr-text-color' as string]: 'var(--foreground)',
          ['--epr-category-label-text-color' as string]:
            'var(--muted-foreground)',
          ['--epr-hover-bg-color' as string]: 'var(--muted)',
          ['--epr-focus-bg-color' as string]: 'var(--muted)',
          ['--epr-highlight-color' as string]: 'var(--primary)',
          ['--epr-category-icon-active-color' as string]: 'var(--primary)',
          ['--epr-search-input-bg-color' as string]: 'var(--muted)',
          ['--epr-search-input-bg-color-active' as string]: 'var(--card)',
          ['--epr-search-input-text-color' as string]: 'var(--foreground)',
          ['--epr-search-input-placeholder-color' as string]:
            'var(--muted-foreground)',
          ['--epr-search-border-color' as string]: 'var(--border)',
          ['--epr-search-border-color-active' as string]: 'var(--primary)',
          ['--epr-picker-border-color' as string]: 'var(--border)',
          ['--epr-preview-border-color' as string]: 'var(--border)',
          // Dark mode equivalents (applied when theme=DARK)
          ['--epr-dark-bg-color' as string]: 'var(--card)',
          ['--epr-dark-category-label-bg-color' as string]: 'var(--card)',
          ['--epr-dark-text-color' as string]: 'var(--foreground)',
          ['--epr-dark-hover-bg-color' as string]: 'var(--surface-secondary)',
          ['--epr-dark-focus-bg-color' as string]: 'var(--surface-secondary)',
          ['--epr-dark-highlight-color' as string]: 'var(--primary)',
          ['--epr-dark-category-icon-active-color' as string]: 'var(--primary)',
          ['--epr-dark-search-input-bg-color' as string]: 'var(--input)',
          ['--epr-dark-search-input-bg-color-active' as string]:
            'var(--surface-secondary)',
          ['--epr-dark-picker-border-color' as string]: 'var(--border)',
          // Size / layout
          ['--epr-picker-border-radius' as string]: '16px 16px 0 0',
          ['--epr-emoji-size' as string]: '22px',
          ['--epr-emoji-padding' as string]: '4px',
          ['--epr-header-padding' as string]: '8px 12px',
          ['--epr-search-bar-inner-padding' as string]: '0 8px',
          ['--epr-search-input-height' as string]: '34px',
          ['--epr-category-navigation-button-size' as string]: '22px',
          ['--epr-preview-height' as string]: '0px',
        }}
      >
        {title ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-card border border-border border-b-0 rounded-t-2xl">
            <div className="text-sm font-semibold text-foreground truncate">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        ) : null}
        <EmojiPicker
          onEmojiClick={(emojiData: EmojiClickData) => {
            onSelectEmoji(emojiData.emoji);
          }}
          theme={resolvedTheme === 'dark' ? Theme.DARK : Theme.LIGHT}
          emojiStyle={EmojiStyle.NATIVE}
          height={height}
          width="100%"
          searchPlaceholder={t('message_input.emoji_search')}
          searchDisabled={isAndroid}
          autoFocusSearch={false}
          skinTonesDisabled
          previewConfig={{ showPreview: false }}
          lazyLoadEmojis
        />
      </div>
    </div>,
    document.body
  );
};

export default EmojiPickerModal;
