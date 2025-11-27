import React, { useState, useRef, useCallback } from 'react';
import Button from '../ui/Button';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
}) => {
  const [newMessage, setNewMessage] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSendMessage = useCallback(() => {
    if (!newMessage.trim() || disabled) return;
    const text = newMessage;
    setNewMessage('');
    onSend(text);
  }, [newMessage, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNewMessage(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    const minHeight = window.innerWidth >= 768 ? 40 : 36;
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), 120);
    textarea.style.height = `${newHeight}px`;
    setInputHeight(newHeight);
  };

  return (
    <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border-t border-gray-100 dark:border-gray-800/50 px-4 md:px-6 py-3 md:py-4">
      <div className="flex items-end gap-2 md:gap-3">
        <div className="flex-1 flex items-center gap-2 bg-white/90 dark:bg-gray-800/70 border border-gray-200 dark:border-gray-700/60 rounded-2xl px-3 md:px-4 py-2 md:py-2.5 shadow-sm hover:shadow focus-within:ring-2 focus-within:ring-blue-500/40 focus-within:border-blue-400/60 dark:focus-within:border-blue-500/40 transition-all duration-200">
          <textarea
            ref={textareaRef}
            value={newMessage}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            inputMode="text"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck="true"
            className="flex-1 min-h-[36px] md:min-h-[40px] max-h-[120px] bg-transparent dark:text-white placeholder-gray-400 dark:placeholder-gray-500 resize-none transition-all duration-200 overflow-y-auto text-[15px] leading-relaxed focus:outline-none"
            style={
              {
                height: `${Math.max(inputHeight, 36)}px`,
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(156, 163, 175, 0.5) transparent',
                // When disabled, let clicks pass through to parent container
                pointerEvents: disabled ? 'none' : 'auto',
              } as React.CSSProperties
            }
          />
          <div className="hidden md:block w-px h-6 bg-gray-200 dark:bg-gray-700/60 mx-1" />
          <div className="shrink-0">
            <Button
              onClick={handleSendMessage}
              variant="primary"
              size="custom"
              className={`w-8 h-8 md:w-9 md:h-9 shrink-0 rounded-full flex items-center justify-center shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all ${
                disabled ? 'opacity-60 cursor-not-allowed' : ''
              } ${!newMessage.trim() || disabled ? 'pointer-events-none' : ''}`}
              title="Send message"
            >
              <svg
                className="w-4 h-4 md:w-5 md:h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessageInput;
