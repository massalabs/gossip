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
import { nearByteLimit, utf8Bytes } from '../../utils/textBytes';

const isWeb = !Capacitor.isNativePlatform();

/** What the input previews of a message: its text and, for a reply, its id. */
export interface InputMessage {
  content: string;
  id?: number;
}

interface MessageInputProps<M extends InputMessage = Message> {
  onSend: (message: string, replyToId?: number) => void;
  disabled?: boolean;
  replyingTo?: M | null;
  onCancelReply?: () => void;
  initialValue?: string;
  onFocus?: () => void;
  forwardPreview?: string | null;
  onCancelForward?: () => void;
  forwardMode?: 'forward' | 'reply';
  editingMessage?: M | null;
  onCancelEdit?: () => void;
  onConfirmEdit?: (newContent: string, message: M) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  isSelecting?: boolean;
  placeholderKey?: string;
  /**
   * The largest text, in UTF-8 bytes. Near it a counter shows; over it the
   * text stays in the input, nothing is sent and `onTooLong` is called.
   */
  maxBytes?: number;
  onTooLong?: () => void;
  /** The label of the editing banner (default: "Editing message"). */
  editingLabel?: string;
  /** Shown above the text box, under the reply and edit banners. */
  aboveInput?: React.ReactNode;
  /** Shown between the text box and the Send button. */
  beforeSend?: React.ReactNode;
  /** The accessible name of the Send button (default: "Send message"). */
  sendLabel?: string;
  /**
   * Options of the Send button, opened by a long press (touch or mouse) or a
   * right-click on it, and by a button for the keyboard and screen readers.
   * With them, a send happens on the click that ends a short press, never
   * on a long one.
   */
  sendOptions?: SendOptions;
}

/** What the Send button's long press opens (see `sendOptions`). */
export interface SendOptions {
  /** Opens them; without it there is nothing to open, only the mark. */
  onOpen?: () => void;
  /** The accessible name of the button that opens them. */
  label: string;
  /** Drawn over the input, near the Send button, while open. */
  menu?: React.ReactNode;
  /** A small mark in the top-right corner of the Send button, with its name. */
  mark?: { icon: React.ReactNode; label: string } | null;
}

/** How long a press on Send lasts before it opens its options. */
const SEND_LONG_PRESS_MS = 500;
/** How far a pointer may move during a long press, in pixels. */
const SEND_LONG_PRESS_SLOP = 10;

function MessageInput<M extends InputMessage = Message>({
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
  maxBytes,
  onTooLong,
  editingLabel,
  aboveInput,
  beforeSend,
  sendLabel,
  sendOptions,
}: MessageInputProps<M>) {
  const { t } = useTranslation('discussions');
  const isRefocusingRef = useRef(false);
  // True while a pointerdown-initiated send is in flight, so the click event
  // that follows the same pointer interaction doesn't send twice.
  const sentViaPointerRef = useRef(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  // The long press on Send (with `sendOptions`): its timer, where it started,
  // and whether it fired, so that the click ending it sends nothing.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const pressFired = useRef(false);
  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  }, []);
  useEffect(() => clearPress, [clearPress]);

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
  const replyToId = replyingTo?.id;
  // What a send would carry: the trimmed text.
  const bytes = maxBytes === undefined ? 0 : utf8Bytes(newMessage.trim());
  const tooLong = maxBytes !== undefined && bytes > maxBytes;
  const showCounter = maxBytes !== undefined && nearByteLimit(bytes, maxBytes);

  const handleSendMessage = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();

      if (sendButtonDisabled) return;
      const cleanedMessage = newMessage.trim();
      if (cleanedMessage.length === 0 && !isForwarding) return;
      if (tooLong) {
        // Kept in the input, to be shortened.
        onTooLong?.();
        return;
      }

      if (editingMessage && onConfirmEdit) {
        onConfirmEdit(cleanedMessage, editingMessage);
      } else {
        onSend(cleanedMessage, replyToId);
      }

      resetTextarea();

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [
      newMessage,
      onSend,
      replyToId,
      resetTextarea,
      sendButtonDisabled,
      isForwarding,
      editingMessage,
      onConfirmEdit,
      textareaRef,
      tooLong,
      onTooLong,
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
        label={editingLabel ?? t('message_input.editing')}
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
      {aboveInput}

      <div className="flex items-end gap-2 md:gap-3">
        <div
          className={`flex-1 min-w-0 flex items-center bg-muted px-4 md:px-5 py-2 md:py-2.5 transition-all duration-200 focus-within:bg-background focus-within:shadow-[inset_0_1px_3px_rgba(0,0,0,0.05)] dark:focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] ${
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
        {beforeSend}
        {sendOptions ? (
          <div className="relative shrink-0 flex items-center">
            {sendOptions.menu}
            <button
              type="button"
              onPointerDown={e => {
                e.preventDefault(); // prevent textarea blur
                pressFired.current = false;
                const open = sendOptions.onOpen;
                if (e.button !== 0 || !open) return;
                pressStart.current = { x: e.clientX, y: e.clientY };
                if (pressTimer.current !== null) {
                  clearTimeout(pressTimer.current);
                }
                pressTimer.current = setTimeout(() => {
                  pressTimer.current = null;
                  pressFired.current = true;
                  try {
                    navigator.vibrate?.(10);
                  } catch {
                    // Vibration not available
                  }
                  open();
                }, SEND_LONG_PRESS_MS);
              }}
              onPointerMove={e => {
                const start = pressStart.current;
                if (!start) return;
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (Math.sqrt(dx * dx + dy * dy) > SEND_LONG_PRESS_SLOP) {
                  clearPress();
                }
              }}
              onPointerUp={clearPress}
              onPointerCancel={clearPress}
              onPointerLeave={clearPress}
              onContextMenu={e => {
                // A right-click, or the long touch of a browser that sends it.
                e.preventDefault();
                clearPress();
                if (pressFired.current || !sendOptions.onOpen) return;
                pressFired.current = true;
                sendOptions.onOpen();
              }}
              onClick={e => {
                // The click that ends a long press sends nothing; a click
                // from the keyboard (no pointer, `detail` 0) always sends.
                if (pressFired.current && e.detail !== 0) {
                  pressFired.current = false;
                  e.preventDefault();
                  return;
                }
                pressFired.current = false;
                handleSendMessage(e);
              }}
              aria-disabled={sendButtonDisabled}
              className={`relative w-11 h-11 shrink-0
                rounded-full flex items-center justify-center select-none [-webkit-touch-callout:none]
                shadow-md hover:shadow-lg transition-all duration-200
                active:scale-90 ${sendButtonDisabled ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'}
                `}
              title={sendLabel ?? t('message_input.send')}
              aria-label={sendLabel ?? t('message_input.send')}
              data-testid="send-button"
            >
              <Send className="w-4 h-4 md:w-5 md:h-5" />
              {sendOptions.mark && (
                <span
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-card border border-border text-foreground flex items-center justify-center"
                  data-testid="send-mark"
                  title={sendOptions.mark.label}
                >
                  {sendOptions.mark.icon}
                </span>
              )}
            </button>
            {sendOptions.onOpen && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  sendOptions.onOpen?.();
                }}
                aria-haspopup="menu"
                aria-label={sendOptions.label}
                className="sr-only focus:not-sr-only focus:absolute focus:-top-12 focus:right-0 focus:whitespace-nowrap focus:px-3 focus:py-2 focus:rounded-lg focus:bg-card focus:border focus:border-border focus:text-sm focus:text-foreground"
                data-testid="send-options"
              >
                {sendOptions.label}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onPointerDown={e => {
              e.preventDefault(); // prevent textarea blur
              sentViaPointerRef.current = true;
              handleSendMessage(e);
            }}
            // Keyboard activation dispatches a click with no pointerdown —
            // without this the send button is unusable from the keyboard.
            onClick={e => {
              if (sentViaPointerRef.current) {
                sentViaPointerRef.current = false;
                return;
              }
              handleSendMessage(e);
            }}
            aria-disabled={sendButtonDisabled}
            className={`w-9 h-9 md:w-10 md:h-10 shrink-0
                rounded-full flex items-center justify-center
                shadow-md hover:shadow-lg transition-all duration-200
                active:scale-90 ${sendButtonDisabled ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'}
                `}
            title={sendLabel ?? t('message_input.send')}
            aria-label={sendLabel ?? t('message_input.send')}
          >
            <Send className="w-4 h-4 md:w-5 md:h-5" />
          </button>
        )}
      </div>
      {showCounter && (
        <p
          className={`mt-2 text-right text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="message-size-counter"
          aria-live="polite"
        >
          {t('message_input.size_counter', { used: bytes, max: maxBytes })}
        </p>
      )}

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
}

export default MessageInput;
