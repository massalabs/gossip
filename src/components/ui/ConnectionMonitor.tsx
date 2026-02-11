import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Move } from 'react-feather';
import {
  gossipSdk,
  SdkEventType,
  Discussion,
  SessionStatus,
} from '@massalabs/gossip-sdk';
import { useOnlineStoreBase } from '../../stores/useOnlineStore';
import { useDiscussionStore } from '../../stores/discussionStore';
import { useAppStore } from '../../stores/appStore';

interface LogEntry {
  id: number;
  timestamp: Date;
  type: 'info' | 'warn' | 'error' | 'status';
  message: string;
}

let logIdCounter = 0;

/**
 * Connection monitor showing each discussion's status.
 * Logs only when status changes to avoid polluting console.
 * Only visible when Show Debug Options is enabled.
 */
const ConnectionMonitor: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isOnline = useOnlineStoreBase(s => s.isOnline);
  const discussions = useDiscussionStore(s => s.discussions);
  const contacts = useDiscussionStore(s => s.contacts);
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const savedPosition = useAppStore(s => s.connectionMonitorPosition);
  const setPosition = useAppStore(s => s.setConnectionMonitorPosition);

  // Drag state refs (no re-renders during drag)
  const isDraggingRef = useRef(false);
  const hasMovedRef = useRef(false);
  const currentPosRef = useRef({ x: savedPosition.x, y: savedPosition.y });
  const dragStartRef = useRef({ x: 0, y: 0 });

  // Track previous statuses to detect changes
  const prevStatusMap = useRef<Map<number, SessionStatus>>(new Map());
  const prevIsOnline = useRef(isOnline);

  // Sync ref with store when savedPosition changes
  useEffect(() => {
    currentPosRef.current = { x: savedPosition.x, y: savedPosition.y };
  }, [savedPosition.x, savedPosition.y]);

  // Update button position directly via DOM
  const updateButtonPosition = useCallback((x: number, y: number) => {
    if (buttonRef.current) {
      buttonRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, []);

  // Clamp position to viewport
  const clampPosition = useCallback((x: number, y: number) => {
    const buttonWidth = buttonRef.current?.offsetWidth || 40;
    const buttonHeight = buttonRef.current?.offsetHeight || 40;
    const maxX = window.innerWidth - buttonWidth;
    const maxY = window.innerHeight - buttonHeight;

    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }, []);

  // Handle pointer down
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    hasMovedRef.current = false;

    dragStartRef.current = {
      x: e.clientX - currentPosRef.current.x,
      y: e.clientY - currentPosRef.current.y,
    };

    if (buttonRef.current) {
      buttonRef.current.style.cursor = 'grabbing';
      buttonRef.current.style.opacity = '0.9';
    }

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  // Handle pointer move
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;

      const newX = e.clientX - dragStartRef.current.x;
      const newY = e.clientY - dragStartRef.current.y;

      if (!hasMovedRef.current) {
        const dx = Math.abs(newX - currentPosRef.current.x);
        const dy = Math.abs(newY - currentPosRef.current.y);
        if (dx > 5 || dy > 5) {
          hasMovedRef.current = true;
        }
      }

      const clamped = clampPosition(newX, newY);
      currentPosRef.current = clamped;
      updateButtonPosition(clamped.x, clamped.y);
    },
    [clampPosition, updateButtonPosition]
  );

  // Handle pointer up
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;

      if (buttonRef.current) {
        buttonRef.current.style.cursor = 'grab';
        buttonRef.current.style.opacity = '1';
      }

      (e.target as HTMLElement).releasePointerCapture(e.pointerId);

      if (!hasMovedRef.current) {
        setIsOpen(prev => !prev);
      } else {
        setPosition(currentPosRef.current);
      }
    },
    [setPosition]
  );

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      const clamped = clampPosition(
        currentPosRef.current.x,
        currentPosRef.current.y
      );

      if (
        clamped.x !== currentPosRef.current.x ||
        clamped.y !== currentPosRef.current.y
      ) {
        currentPosRef.current = clamped;
        updateButtonPosition(clamped.x, clamped.y);
        setPosition(clamped);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampPosition, updateButtonPosition, setPosition]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const entry: LogEntry = {
      id: logIdCounter++,
      timestamp: new Date(),
      type,
      message,
    };
    setLogs(prev => [...prev.slice(-49), entry]);

    // Console log only for status changes
    const prefix = '[DiscussionStatus]';
    switch (type) {
      case 'error':
        console.error(prefix, message);
        break;
      case 'warn':
        console.warn(prefix, message);
        break;
      case 'status':
        console.log(prefix, message);
        break;
      default:
        break;
    }
  }, []);

  // Track network status changes
  useEffect(() => {
    if (prevIsOnline.current !== isOnline) {
      addLog('status', `Network: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
      prevIsOnline.current = isOnline;
    }
  }, [isOnline, addLog]);

  // Track discussion status changes
  useEffect(() => {
    discussions.forEach(d => {
      const prevStatus = prevStatusMap.current.get(d.id!);
      const currentStatus = gossipSdk.discussions.getStatus(d.contactUserId);
      if (prevStatus !== undefined && prevStatus !== currentStatus) {
        const contact = contacts.find(c => c.userId === d.contactUserId);
        const name = contact?.name || d.contactUserId.slice(0, 12) + '...';
        const isError =
          currentStatus === SessionStatus.Killed ||
          currentStatus === SessionStatus.Saturated;
        addLog(
          isError ? 'error' : 'status',
          `${name}: ${getStatusLabel(d.contactUserId)} -> ${getStatusLabel(d.contactUserId)}`
        );
      }
      prevStatusMap.current.set(d.id!, currentStatus);
    });
  }, [discussions, contacts, addLog]);

  // Subscribe to SDK events
  useEffect(() => {
    const handleSessionRenewed = (discussion: Discussion) => {
      const contact = contacts.find(c => c.userId === discussion.contactUserId);
      const name =
        contact?.name || discussion.contactUserId?.slice(0, 12) + '...';
      addLog('status', `${name}: SESSION RENEWED`);
    };

    const handleError = (error: Error, context: string) => {
      addLog('error', `SDK [${context}]: ${error.message}`);
    };

    gossipSdk.on(SdkEventType.SESSION_RENEWED, handleSessionRenewed);
    gossipSdk.on(SdkEventType.ERROR, handleError);

    return () => {
      gossipSdk.off(SdkEventType.SESSION_RENEWED, handleSessionRenewed);
      gossipSdk.off(SdkEventType.ERROR, handleError);
    };
  }, [addLog, contacts]);

  // Auto-scroll
  useEffect(() => {
    if (isOpen && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isOpen]);

  // Don't render if debug options are disabled
  if (!showDebugOption) {
    return null;
  }

  // Check if any discussion has a problem
  const hasProblems = discussions.some(d => {
    const currentStatus = gossipSdk.discussions.getStatus(d.contactUserId);
    return (
      currentStatus === SessionStatus.Killed ||
      currentStatus === SessionStatus.Saturated
    );
  });

  const getButtonColor = () => {
    if (!isOnline) return 'bg-red-500';
    if (hasProblems) return 'bg-orange-500';
    return 'bg-green-500';
  };

  const getStatusColor = (contactUserId: string) => {
    const status = gossipSdk.discussions.getStatus(contactUserId);
    switch (status) {
      case SessionStatus.Active:
        return 'text-green-400';
      case SessionStatus.PeerRequested:
      case SessionStatus.SelfRequested:
        return 'text-yellow-400';
      case SessionStatus.Killed:
      case SessionStatus.Saturated:
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'error':
        return 'text-red-400';
      case 'warn':
        return 'text-yellow-400';
      case 'status':
        return 'text-blue-400';
      default:
        return 'text-gray-300';
    }
  };

  const formatTime = (date: Date) =>
    date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const clearLogs = () => setLogs([]);

  const getContactName = (contactUserId: string) => {
    const contact = contacts.find(c => c.userId === contactUserId);
    return contact?.name || contactUserId.slice(0, 10) + '...';
  };

  return (
    <>
      {/* Floating monitor button - draggable */}
      <button
        ref={buttonRef}
        className="fixed top-0 left-0 z-50 w-10 h-10 rounded-full shadow-lg flex items-center justify-center select-none touch-none cursor-grab bg-gray-800 border border-gray-600"
        style={{
          transform: `translate(${savedPosition.x}px, ${savedPosition.y}px)`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-label="Toggle connection monitor"
      >
        <div className="relative">
          <div
            className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${getButtonColor()}`}
          />
          <Move className="w-3 h-3 text-gray-400 absolute -top-2 -left-2" />
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        </div>
      </button>

      {/* Monitor panel */}
      {isOpen && (
        <div
          className="fixed z-50 w-72 max-h-96 bg-gray-900 rounded-lg shadow-xl border border-gray-700 flex flex-col"
          style={{
            left: savedPosition.x + 50,
            top: savedPosition.y,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-2 border-b border-gray-700">
            <span className="text-white font-medium text-xs">
              Discussion Status
            </span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white p-0.5"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>

          {/* Discussions list */}
          <div className="p-2 border-b border-gray-700 bg-gray-800">
            <div className="text-xs text-gray-400 mb-1">Current Status:</div>
            {discussions.length === 0 ? (
              <div className="text-gray-500 text-xs">No discussions</div>
            ) : (
              <div className="space-y-0.5">
                {discussions.map(d => (
                  <div key={d.id} className="flex justify-between text-xs">
                    <span className="text-gray-300 truncate max-w-[140px]">
                      {getContactName(d.contactUserId)}
                    </span>
                    <span className={getStatusColor(d.contactUserId)}>
                      {getStatusLabel(d.contactUserId)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Network status */}
          <div className="px-2 py-1 border-b border-gray-700 text-xs">
            <span className="text-gray-400">
              Network:{' '}
              <span className={isOnline ? 'text-green-400' : 'text-red-400'}>
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </span>
          </div>

          {/* Change logs */}
          <div className="flex items-center justify-between px-2 py-1 border-b border-gray-700">
            <span className="text-xs text-gray-400">Changes:</span>
            {logs.length > 0 && (
              <button
                onClick={clearLogs}
                className="text-gray-500 hover:text-white text-xs"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs max-h-32">
            {logs.length === 0 ? (
              <div className="text-gray-500 text-center py-1">
                No changes yet
              </div>
            ) : (
              logs.map(log => (
                <div key={log.id} className="mb-0.5 leading-tight">
                  <span className="text-gray-500">
                    {formatTime(log.timestamp)}
                  </span>{' '}
                  <span className={getLogColor(log.type)}>{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </>
  );
};

function getStatusLabel(contactUserId: string): string {
  const status = gossipSdk.discussions.getStatus(contactUserId);
  switch (status) {
    case SessionStatus.PeerRequested:
    case SessionStatus.SelfRequested:
      return 'PENDING';
    case SessionStatus.Active:
      return 'ACTIVE';
    case SessionStatus.Killed:
      return 'KILLED';
    case SessionStatus.Saturated:
      return 'SATURATED';
    default:
      return 'UNKNOWN';
  }
}

export default ConnectionMonitor;
