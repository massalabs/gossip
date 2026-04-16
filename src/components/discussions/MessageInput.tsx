import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Smile } from 'react-feather';
import InputPreviewBanner from './InputPreviewBanner';
import EmojiPickerModal from '../ui/EmojiPickerModal';
import { Capacitor } from '@capacitor/core';
import { Message } from '@massalabs/gossip-sdk';
import { useKeyboardStore } from '../../stores/keyboardStore';
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea';
import { useInitialValue } from '../../hooks/useInitialValue';

const isWeb = !Capacitor.isNativePlatform();

interface MessageInputProps {
  onSend: (message: string, replyToMessageId?: Uint8Array) => void;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  initialValue?: string;
  onFocus?: () => void;
  forwardPreview?: string | null;
  onCancelForward?: () => void;
  forwardMode?: 'forward' | 'reply';
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  onConfirmEdit?: (newContent: string, message: Message) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  isSelecting?: boolean;
  placeholderKey?: string;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
  replyingTo,
  onCancelReply,
  initialValue,
  onFocus,
  forwardPreview,
  onCancelForward,
  forwardMode = 'forward',
  editingMessage,
  onCancelEdit,
  onConfirmEdit,
  containerRef,
  isSelecting = false,
  placeholderKey,
}) => {
  const { t } = useTranslation('discussions');
  const isRefocusingRef = useRef(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);

  const {
    textareaRef,
    value: newMessage,
    isMultiline: isTextareaMultiline,
    reset: resetTextarea,
    handleChange: handleTextareaChange,
    focusOnBackground: focusTextarea,
    resize: autoResizeTextarea,
    setValue: setNewMessage,
  } = useAutoResizeTextarea(initialValue);

  useInitialValue({
    initialValue,
    textareaRef,
    setValue: setNewMessage,
    currentValue: newMessage,
    resize: autoResizeTextarea,
  });

  // Blur textarea when keyboard hides — on iOS the textarea stays activeElement
  // after keyboard dismiss, causing any subsequent tap to re-open the keyboard.
  // Delay to avoid race with focus transfers (e.g. search input → textarea).
  const isKeyboardVisible = useKeyboardStore(s => s.isVisible);
  useEffect(() => {
    if (isKeyboardVisible) return;
    const timer = setTimeout(() => {
      if (
        !useKeyboardStore.getState().isVisible &&
        document.activeElement === textareaRef.current
      ) {
        textareaRef.current?.blur();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isKeyboardVisible, textareaRef]);

  const isForwarding = !!forwardPreview;
  const sendButtonDisabled = disabled || (!newMessage.trim() && !isForwarding);
  const replyToMessageId = replyingTo?.messageId;

  const handleSendMessage = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();

      if (sendButtonDisabled) return;
      const cleanedMessage = newMessage.trim();
      if (cleanedMessage.length === 0 && !isForwarding) return;

      if (editingMessage && onConfirmEdit) {
        onConfirmEdit(cleanedMessage, editingMessage);
      } else {
        onSend(cleanedMessage, replyToMessageId);
      }

      resetTextarea();

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [
      newMessage,
      onSend,
      replyToMessageId,
      resetTextarea,
      sendButtonDisabled,
      isForwarding,
      editingMessage,
      onConfirmEdit,
      textareaRef,
    ]
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (Capacitor.isNativePlatform()) return;
      if (e.nativeEvent.isComposing) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        handleSendMessage(e);
      }
    },
    [handleSendMessage]
  );

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current;
      const cursor = textarea?.selectionStart ?? newMessage.length;
      const updated =
        newMessage.slice(0, cursor) + emoji + newMessage.slice(cursor);
      setNewMessage(updated);
      requestAnimationFrame(() => {
        autoResizeTextarea();
        if (textarea) {
          const pos = cursor + emoji.length;
          textarea.focus();
          textarea.setSelectionRange(pos, pos);
        }
      });
    },
    [newMessage, setNewMessage, autoResizeTextarea, textareaRef]
  );

  return (
    <div
      ref={containerRef}
      className={`bg-card border-t border-border px-4 md:px-8 py-3 md:py-4 transition-opacity duration-300 ease-out transform-gpu ${
        isSelecting ? 'pointer-events-none opacity-50' : 'opacity-100'
      }`}
      onClick={focusTextarea}
      aria-hidden={isSelecting}
    >
      <InputPreviewBanner
        isVisible={!!editingMessage}
        label={t('message_input.editing')}
        content={editingMessage?.content ?? ''}
        onCancel={onCancelEdit}
        cancelAriaLabel={t('message_input.cancel_edit')}
      />
      <InputPreviewBanner
        isVisible={!!replyingTo}
        label={t('message_input.replying_to')}
        content={replyingTo?.content ?? ''}
        onCancel={onCancelReply}
        cancelAriaLabel={t('message_input.cancel_reply')}
      />
      <InputPreviewBanner
        isVisible={!!forwardPreview}
        label={
          forwardMode === 'reply'
            ? t('message_input.replying_to')
            : t('message_input.forwarding')
        }
        content={forwardPreview ?? ''}
        onCancel={onCancelForward}
        cancelAriaLabel={t('message_input.cancel_forward')}
      />

      <div className="flex items-end gap-2 md:gap-3">
        <div
          className={`flex-1 min-w-0 flex items-center bg-muted px-4 md:px-5 py-2 md:py-2.5 transition-all duration-200 ${
            isTextareaMultiline ? 'rounded-2xl' : 'rounded-full'
          }`}
          onClick={focusTextarea}
        >
          {isWeb && (
            <button
              type="button"
              // onPointerDown + preventDefault keeps focus on the textarea
              // so the emoji is inserted at the correct cursor position
              onPointerDown={e => {
                e.preventDefault();
                e.stopPropagation();
                setIsEmojiPickerOpen(true);
              }}
              className="shrink-0 mr-2 text-muted-foreground hover:text-foreground transition-colors duration-150"
              title={t('message_input.emoji')}
              aria-label={t('message_input.emoji')}
            >
              <Smile className="w-5 h-5" />
            </button>
          )}
          <textarea
            ref={textareaRef}
            value={newMessage}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onFocus={() => {
              if (isRefocusingRef.current) return;
              onFocus?.();
            }}
            placeholder={t(placeholderKey ?? 'message_input.placeholder')}
            rows={1}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="sentences"
            spellCheck={true}
            enterKeyHint="send"
            aria-label={t('message_input.input_label')}
            className={`flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
                       leading-relaxed resize-none p-0 m-0 focus:outline-none outline-none
                       scrollbar-transparent select-text touch-auto
                       ${isTextareaMultiline ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
            style={{ fontSize: '16px' }}
          />
        </div>
        <button
          onPointerDown={e => {
            e.preventDefault(); // prevent textarea blur
            handleSendMessage(e);
          }}
          className={`w-9 h-9 md:w-10 md:h-10 shrink-0
              rounded-full flex items-center justify-center
              shadow-md hover:shadow-lg transition-all duration-200
              active:scale-90 ${sendButtonDisabled ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'}
              `}
          title={t('message_input.send')}
          aria-label={t('message_input.send')}
        >
          <Send className="w-4 h-4 md:w-5 md:h-5" />
        </button>
      </div>

      {isWeb && (
        <EmojiPickerModal
          isOpen={isEmojiPickerOpen}
          onClose={() => setIsEmojiPickerOpen(false)}
          onSelectEmoji={handleEmojiSelect}
          height={400}
        />
      )}
    </div>
  );
};

export default MessageInput;
