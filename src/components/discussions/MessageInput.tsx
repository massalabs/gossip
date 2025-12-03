import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, X } from 'react-feather';
import Button from '../ui/Button';
import { Message } from '../../db';

const TEXTAREA_MIN_HEIGHT_DESKTOP = 40;
const TEXTAREA_MIN_HEIGHT_MOBILE = 36;
const TEXTAREA_MAX_HEIGHT = 120;
const DESKTOP_BREAKPOINT = 768;

interface MessageInputProps {
  onSend: (message: string, replyToId?: number) => void;
  onClick?: () => void;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  onClick,
  disabled = false,
  replyingTo,
  onCancelReply,
}) => {
  const [newMessage, setNewMessage] = useState('');
  const [inputHeight, setInputHeight] = useState(TEXTAREA_MIN_HEIGHT_DESKTOP);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const getMinHeight = useCallback(() => {
    return window.innerWidth >= DESKTOP_BREAKPOINT
      ? TEXTAREA_MIN_HEIGHT_DESKTOP
      : TEXTAREA_MIN_HEIGHT_MOBILE;
  }, []);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const minHeight = getMinHeight();
    const newHeight = Math.min(
      Math.max(scrollHeight, minHeight),
      TEXTAREA_MAX_HEIGHT
    );

    textarea.style.height = `${newHeight}px`;
    setInputHeight(newHeight);
  }, [getMinHeight]);

  const focusTextarea = useCallback(() => {
    textareaRef.current?.focus();
    const len = textareaRef.current?.value.length || 0;
    textareaRef.current?.setSelectionRange(len, len);
  }, []);

  // visualViewport fix for iOS keyboard
  useEffect(() => {
    if (window.innerWidth >= DESKTOP_BREAKPOINT) return;

    const handleVV = () => requestAnimationFrame(focusTextarea);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleVV);
      vv.addEventListener('scroll', handleVV);
      return () => {
        vv.removeEventListener('resize', handleVV);
        vv.removeEventListener('scroll', handleVV);
      };
    }
  }, [focusTextarea]);

  // Window resize
  useEffect(() => {
    const handleResize = () => adjustHeight();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [adjustHeight]);

  const handleSendMessage = useCallback(() => {
    const trimmed = newMessage.trim();
    if (!trimmed || disabled) return;

    const isMobile = window.innerWidth < DESKTOP_BREAKPOINT;

    // 1. Hold keyboard with hidden input (iOS/Android)
    if (isMobile && hiddenInputRef.current) {
      hiddenInputRef.current.focus();
    }

    // 2. Clear
    setNewMessage('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = `${getMinHeight()}px`;
    }
    setInputHeight(getMinHeight());

    // 3. Send
    onSend(trimmed, replyingTo?.id);

    // 4. Refocus
    setTimeout(focusTextarea, 10);
  }, [newMessage, disabled, onSend, replyingTo, getMinHeight, focusTextarea]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNewMessage(e.target.value);
    adjustHeight();
  };

  const preventFocusLoss = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
  };

  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active === textareaRef.current ||
        (containerRef.current && containerRef.current.contains(active as Node))
      ) {
        // Focus is still inside our component → pull it back
        focusTextarea();
      }
      // Else: user tapped outside → allow blur (keyboard hides)
    });
  }, [focusTextarea]);

  // Cancel reply → refocus textarea
  const handleCancelReply = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCancelReply?.();
    setTimeout(focusTextarea, 0);
  };

  // Optional: tap container background to focus (nice UX)
  const handleContainerTap = () => {
    onClick?.();
    focusTextarea();
  };

  return (
    <>
      <div
        ref={containerRef}
        className="bg-card/60 dark:bg-card/80 backdrop-blur-xl border-t border-border px-6 md:px-10 py-3 md:py-4"
        onClick={handleContainerTap}
      >
        {/* Reply Preview */}
        {replyingTo && (
          <div className="mb-2 px-3 py-2 bg-muted/50 border-l-2 border-primary rounded-r-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground/80 truncate">
                  {replyingTo.content}
                </p>
              </div>
              {onCancelReply && (
                <button
                  onClick={handleCancelReply}
                  onMouseDown={preventFocusLoss}
                  onTouchStart={preventFocusLoss}
                  className="shrink-0 p-1 hover:bg-muted rounded transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 md:gap-3">
          <div className="flex-1 flex items-center gap-2 bg-card dark:bg-card/70 border border-border rounded-xl px-3 md:px-4 py-2 md:py-2.5 focus-within:ring-2 focus-within:ring-ring focus-within:border-ring transition-all duration-200">
            <textarea
              ref={textareaRef}
              value={newMessage}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              placeholder="Type a message..."
              rows={1}
              inputMode="text"
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="sentences"
              spellCheck={true}
              className="flex-1 min-h-[36px] md:min-h-[40px] max-h-[120px] bg-transparent text-foreground placeholder:text-muted-foreground resize-none overflow-y-auto text-[15px] leading-relaxed focus:outline-none"
              style={
                {
                  height: `${Math.max(inputHeight, TEXTAREA_MIN_HEIGHT_MOBILE)}px`,
                  pointerEvents: disabled ? 'none' : 'auto',
                } as React.CSSProperties
              }
            />

            <div className="hidden md:block w-px h-6 bg-border/80 mx-1" />

            {/* Send Button */}
            <Button
              onClick={handleSendMessage}
              onMouseDown={preventFocusLoss}
              onTouchStart={preventFocusLoss}
              variant="primary"
              size="custom"
              disabled={disabled || !newMessage.trim()}
              className="w-8 h-8 md:w-9 md:h-9 shrink-0 rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all"
              title="Send message"
            >
              <Send className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Hidden input — prevents keyboard close on send */}
      <input
        ref={hiddenInputRef}
        type="text"
        inputMode="text"
        style={{
          position: 'fixed',
          bottom: 0,
          left: '-100px',
          opacity: 0,
          pointerEvents: 'none',
          height: '1px',
          width: '1px',
          zIndex: -1,
        }}
        tabIndex={-1}
      />
    </>
  );
};

export default MessageInput;
