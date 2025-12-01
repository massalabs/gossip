import React, { useState, useEffect } from 'react';
import {
  getDebugLogs,
  addLogsListener,
  removeLogsListener,
  clearDebugLogs,
  DebugLog,
} from './debugLogs';
import Button from './Button';

import { useAppStore } from '../../stores/appStore';

const DebugOverlay: React.FC = () => {
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const debugOverlayVisible = useAppStore(s => s.debugOverlayVisible);
  const setDebugOverlayVisible = useAppStore(s => s.setDebugOverlayVisible);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [showRawText, setShowRawText] = useState(false);

  useEffect(() => {
    const updateLogs = () => {
      setLogs([...getDebugLogs()]);
    };

    addLogsListener(updateLogs);

    return () => {
      removeLogsListener(updateLogs);
    };
  }, []);

  const copyTextToClipboard = async (text: string, successMessage: string) => {
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers or non-secure contexts
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (successful) {
          alert(successMessage);
        } else {
          throw new Error('Copy command failed');
        }
      }
    } catch (err) {
      console.error('Copy failed:', err);
      alert(
        'Failed to copy. Please select and copy the text manually or take a screenshot.'
      );
    }
  };

  const copyLogsToClipboard = async () => {
    const logsText = getDebugLogs()
      .map(log => `[${log.timestamp}] ${log.message}`)
      .join('\n');

    await copyTextToClipboard(logsText, 'Debug logs copied to clipboard!');
  };

  const copySingleLogToClipboard = async (log: DebugLog) => {
    const line = `[${log.timestamp}] ${log.message}`;
    await copyTextToClipboard(line, 'Log line copied to clipboard!');
  };

  if (!showDebugOption) {
    return null;
  }

  if (!debugOverlayVisible) {
    return (
      <div className="w-full flex justify-center items-center">
        <Button
          variant="outline"
          onClick={() => setDebugOverlayVisible(true)}
          className="fixed top-2 z-1000 bg-amber-50"
        >
          Show Debug
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-white w-full rounded-t-lg shadow-xl flex flex-col fixed inset-0 z-50 bg-opacity-50 items-end h-full">
      <div className="flex justify-between items-center p-3 border-b w-full">
        <h3 className="font-semibold text-sm">Debug Console</h3>
        <div className="flex gap-2">
          <Button
            onClick={copyLogsToClipboard}
            variant="outline"
            size="custom"
            className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 border border-blue-600 rounded"
          >
            Copy
          </Button>
          <Button
            onClick={() => setShowRawText(!showRawText)}
            variant="outline"
            size="custom"
            className="text-xs text-purple-600 hover:text-purple-800 px-2 py-1 border border-purple-600 rounded"
          >
            {showRawText ? 'Pretty' : 'Raw'}
          </Button>
          <Button
            onClick={() => {
              clearDebugLogs();
              setLogs([]);
            }}
            variant="outline"
            size="custom"
            className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border rounded"
          >
            Clear
          </Button>
          <Button
            onClick={() => setDebugOverlayVisible(false)}
            variant="outline"
            size="custom"
            className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 border rounded"
          >
            Close
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs w-full">
        {logs.length === 0 ? (
          <p className="text-gray-500 text-center py-4">No logs yet</p>
        ) : showRawText ? (
          <textarea
            readOnly
            value={getDebugLogs()
              .map(log => `[${log.timestamp}] ${log.message}`)
              .join('\n')}
            className="w-full h-full p-2 border rounded bg-gray-50 resize-none"
            onClick={e => (e.target as HTMLTextAreaElement).select()}
          />
        ) : (
          <div className="space-y-1">
            {logs.map((log, index) => (
              <div key={index} className="border-b border-gray-100 pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <span className="text-gray-500">[{log.timestamp}]</span>{' '}
                    <span className="text-gray-900">{log.message}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="custom"
                    className="text-[10px] px-1 py-0.5 border rounded"
                    onClick={() => copySingleLogToClipboard(log)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DebugOverlay;
