import React from 'react';

interface DiscussionDebugButtonProps {
  show: boolean;
  isSending: boolean;
  testMessageCount: number;
  onSend: () => void;
}

const DiscussionDebugButton: React.FC<DiscussionDebugButtonProps> = ({
  show,
  isSending,
  testMessageCount,
  onSend,
}) => {
  if (!show) {
    return null;
  }

  return (
    <div className="absolute bottom-32 right-4 z-10">
      <button
        onClick={onSend}
        disabled={isSending}
        className={`w-12 h-12 rounded-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white shadow-lg border border-border flex items-center justify-center text-xs font-bold transition-all ${
          isSending ? 'animate-pulse' : ''
        }`}
        title={`Send ${testMessageCount} test messages (Debug)`}
      >
        {isSending ? '...' : testMessageCount.toString()}
      </button>
    </div>
  );
};

export default DiscussionDebugButton;
