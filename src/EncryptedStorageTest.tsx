/**
 * Mobile Storage Test - Visual test for encrypted storage on phones
 *
 * Features:
 * - Session create/unlock
 * - Users table with create user
 * - Messages table with lorem ipsum
 * - Visual file representation (byte grid)
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// Worker communication types
interface SqlResult {
  success: boolean;
  rows?: Record<string, unknown>[];
  columns?: string[];
  changes?: number;
  lastInsertRowid?: number;
  error?: string;
}

interface FileDataResult {
  success: boolean;
  data?: Uint8Array;
  size?: number;
  error?: string;
}

interface WorkerStatus {
  initialized: boolean;
  sessionUnlocked: boolean;
  dbOpen: boolean;
}

// Lorem ipsum generator
const LOREM_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'do',
  'eiusmod',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'et',
  'dolore',
  'magna',
  'aliqua',
  'enim',
  'ad',
  'minim',
  'veniam',
  'quis',
  'nostrud',
];

function generateLorem(wordCount: number): string {
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)]);
  }
  return words.join(' ');
}

// File constants
const FILE_ADDRESSING = 0;
const FILE_DATA = 1;

export default function EncryptedStorageTest() {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [password, setPassword] = useState('test123');
  const [newUserName, setNewUserName] = useState('');
  const [users, setUsers] = useState<
    { id: number; name: string; created_at: string }[]
  >([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);

  // File visualization
  const [addressingData, setAddressingData] = useState<Uint8Array | null>(null);
  const [dataFileData, setDataFileData] = useState<Uint8Array | null>(null);
  const [addressingSize, setAddressingSize] = useState(0);
  const [dataSize, setDataSize] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const pendingRequests = useRef<Map<number, (result: unknown) => void>>(
    new Map()
  );
  const messageIdRef = useRef(0);

  const log = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${msg}`, ...prev.slice(0, 49)]);
  }, []);

  // Initialize worker
  const initWorker = useCallback(() => {
    if (workerRef.current) {
      log('Worker already initialized');
      return;
    }

    log('Starting worker...');
    const worker = new Worker(new URL('./storage-worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = e => {
      const data = e.data;

      if (data.type === 'log') {
        log(`[Worker] ${data.message}`);
        return;
      }

      if (data.type?.endsWith('-result') && data.id !== undefined) {
        const resolver = pendingRequests.current.get(data.id);
        if (resolver) {
          pendingRequests.current.delete(data.id);
          resolver(data);
        }
      }
    };

    worker.onerror = e => {
      log(`Worker error: ${e.message}`);
    };

    workerRef.current = worker;
    log('Worker created');
  }, [log]);

  // Send message to worker
  const send = useCallback(
    <T = unknown,>(
      type: string,
      data?: Record<string, unknown>
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error('Worker not initialized'));
          return;
        }

        const id = ++messageIdRef.current;
        pendingRequests.current.set(id, resolve as (result: unknown) => void);

        workerRef.current.postMessage({ type, id, ...data });

        setTimeout(() => {
          if (pendingRequests.current.has(id)) {
            pendingRequests.current.delete(id);
            reject(new Error('Request timeout'));
          }
        }, 60000);
      });
    },
    []
  );

  // Refresh file visualization
  const refreshFileData = useCallback(async () => {
    try {
      // Get addressing file (2MB)
      const addrResult = await send<FileDataResult>('get-file-data', {
        fileId: FILE_ADDRESSING,
        maxBytes: 65536, // First 64KB
      });
      if (addrResult.success && addrResult.data) {
        setAddressingData(addrResult.data);
        setAddressingSize(addrResult.size || 0);
      }

      // Get data file
      const dataResult = await send<FileDataResult>('get-file-data', {
        fileId: FILE_DATA,
        maxBytes: 65536, // First 64KB
      });
      if (dataResult.success && dataResult.data) {
        setDataFileData(dataResult.data);
        setDataSize(dataResult.size || 0);
      }
    } catch (err) {
      log(`File data error: ${err}`);
    }
  }, [send, log]);

  // Initialize storage
  const handleInit = async () => {
    try {
      initWorker();
      const result = await send<{ success: boolean; error?: string }>('init');
      if (result.success) {
        log('Storage initialized');
        await refreshFileData();
      } else {
        log(`Init failed: ${result.error}`);
      }
      await refreshStatus();
    } catch (err) {
      log(`Init error: ${err}`);
    }
  };

  // Create session
  const handleCreateSession = async () => {
    try {
      log(`Creating session with password: ${password}`);
      const result = await send<{ success: boolean; error?: string }>(
        'create-session',
        { password }
      );
      if (result.success) {
        log('Session created');
        await createTables();
        await refreshFileData();
      } else {
        log(`Create session failed: ${result.error}`);
      }
      await refreshStatus();
    } catch (err) {
      log(`Create session error: ${err}`);
    }
  };

  // Unlock session
  const handleUnlockSession = async () => {
    try {
      log(`Unlocking session with password: ${password}`);
      const result = await send<{ success: boolean; error?: string }>(
        'unlock-session',
        { password }
      );
      if (result.success) {
        log('Session unlocked - checking data size...');
        await refreshFileData();
        log(
          `Files: addressing=${formatBytes(addressingSize)}, data=${formatBytes(dataSize)}`
        );
        await createTables();
        await fetchUsers();
      } else {
        log(`Unlock failed: ${result.error}`);
      }
      await refreshStatus();
    } catch (err) {
      log(`Unlock error: ${err}`);
    }
  };

  // Lock session
  const handleLockSession = async () => {
    try {
      await send('lock-session');
      log('Session locked');
      setUsers([]);
      setMessages([]);
      setSelectedUserId(null);
      await refreshStatus();
      await refreshFileData();
    } catch (err) {
      log(`Lock error: ${err}`);
    }
  };

  // Create tables
  const createTables = async () => {
    // Users table
    await send<SqlResult>('exec', {
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,
    });

    // Messages table
    await send<SqlResult>('exec', {
      sql: `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    });

    log('Tables ready');
    await fetchUsers();
  };

  // Fetch users
  const fetchUsers = async () => {
    const result = await send<SqlResult>('exec', {
      sql: 'SELECT * FROM users ORDER BY id',
    });
    log(`fetchUsers result: ${JSON.stringify(result)}`);
    if (result.success && result.rows) {
      setUsers(
        result.rows as { id: number; name: string; created_at: string }[]
      );
      log(`Loaded ${result.rows.length} users`);
    } else if (result.error) {
      log(`fetchUsers error: ${result.error}`);
    }
  };

  // Create user
  const handleCreateUser = async () => {
    if (!newUserName.trim()) return;

    try {
      const sql = `INSERT INTO users (name, created_at) VALUES ('${newUserName}', '${new Date().toISOString()}')`;
      const result = await send<SqlResult>('exec', { sql });

      if (result.success) {
        log(`Created user: ${newUserName}`);
        setNewUserName('');
        await fetchUsers();
        await refreshFileData();
      } else {
        log(`Create user failed: ${result.error}`);
      }
    } catch (err) {
      log(`Create user error: ${err}`);
    }
  };

  // Add lorem ipsum message
  const handleAddMessage = async () => {
    if (!selectedUserId) {
      log('Select a user first');
      return;
    }

    try {
      const content = generateLorem(10 + Math.floor(Math.random() * 20));
      const sql = `INSERT INTO messages (user_id, content, timestamp) VALUES (${selectedUserId}, '${content}', '${new Date().toISOString()}')`;
      const result = await send<SqlResult>('exec', { sql });

      if (result.success) {
        log(`Added message for user ${selectedUserId}`);
        await fetchMessages();
        await refreshFileData();
      } else {
        log(`Add message failed: ${result.error}`);
      }
    } catch (err) {
      log(`Add message error: ${err}`);
    }
  };

  // Fetch messages for selected user
  const fetchMessages = useCallback(async () => {
    if (!selectedUserId) return;

    const sql = `SELECT * FROM messages WHERE user_id = ${selectedUserId} ORDER BY id DESC`;
    const result = await send<SqlResult>('exec', { sql });

    if (result.success && result.rows) {
      setMessages(result.rows);
      log(`Loaded ${result.rows.length} messages`);
    }
  }, [selectedUserId, send, log]);

  // Refresh status
  const refreshStatus = async () => {
    try {
      const result = await send<WorkerStatus & { type?: string }>('status');
      setStatus(result);
    } catch (err) {
      log(`Status error: ${err}`);
    }
  };

  // Cleanup worker properly before page unload
  const handleCleanup = async () => {
    try {
      log('Cleaning up worker...');
      await send('cleanup');
      log('Worker cleaned up. Safe to refresh.');
    } catch (err) {
      log(`Cleanup error: ${err}`);
    }
  };

  // Clear OPFS storage (for debugging)
  const handleClearStorage = async () => {
    try {
      // First cleanup the worker to release handles
      if (workerRef.current) {
        try {
          await send('cleanup');
        } catch {
          // Worker might not respond, that's ok
        }
        workerRef.current.terminate();
        workerRef.current = null;
      }

      log('Clearing OPFS storage...');
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('gossip-storage', { recursive: true });
      log('Storage cleared! Refresh the page to start fresh.');
      alert('Storage cleared! Please refresh the page.');
    } catch (err) {
      log(`Clear storage error: ${err}`);
    }
  };

  // Auto-fetch messages when user selected
  useEffect(() => {
    if (selectedUserId && status?.sessionUnlocked) {
      fetchMessages();
    }
  }, [fetchMessages, selectedUserId, status?.sessionUnlocked]);

  // Cleanup on page unload to prevent corruption
  useEffect(() => {
    const handleUnload = () => {
      if (workerRef.current) {
        // Best effort cleanup - won't wait for response
        workerRef.current.postMessage({ type: 'cleanup' });
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  return (
    <div
      style={{
        height: '100vh',
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
        background: '#fff',
      }}
    >
      <div
        style={{
          padding: 16,
          fontFamily: 'system-ui',
          maxWidth: 600,
          margin: '0 auto',
        }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>📱 Storage Test</h1>

        {/* Status */}
        <StatusBar status={status} />

        {/* 1. Init & Session */}
        <Section title="1. Init & Session">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={handleInit}>Init Worker</Button>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              style={inputStyle}
            />
            <Button onClick={handleCreateSession} color="#51cf66">
              Create
            </Button>
            <Button onClick={handleUnlockSession}>Unlock</Button>
            <Button onClick={handleLockSession} color="#ff6b6b">
              Lock
            </Button>
          </div>
        </Section>

        {/* 2. Users */}
        <Section title="2. Users">
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              type="text"
              value={newUserName}
              onChange={e => setNewUserName(e.target.value)}
              placeholder="User name"
              style={{ ...inputStyle, flex: 1 }}
            />
            <Button onClick={handleCreateUser} color="#51cf66">
              + Add User
            </Button>
          </div>
          <select
            value={selectedUserId ?? ''}
            onChange={e => setSelectedUserId(Number(e.target.value) || null)}
            style={{ ...inputStyle, width: '100%', padding: '10px' }}
          >
            <option value="">-- Select User --</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.name} (id: {u.id})
              </option>
            ))}
          </select>
        </Section>

        {/* 3. Messages */}
        <Section title="3. Messages">
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Button onClick={handleAddMessage} color="#51cf66">
              + Add Lorem Ipsum
            </Button>
            <Button onClick={fetchMessages}>Refresh</Button>
            <span style={{ fontSize: 14, alignSelf: 'center' }}>
              {messages.length} messages
            </span>
          </div>
          {messages.length > 0 && (
            <div
              style={{
                maxHeight: 120,
                overflow: 'auto',
                background: '#f8f9fa',
                borderRadius: 6,
                padding: 8,
              }}
            >
              {messages.slice(0, 5).map((m, i) => (
                <div
                  key={i}
                  style={{
                    padding: 6,
                    borderBottom: '1px solid #eee',
                    fontSize: 13,
                  }}
                >
                  {String(m.content).substring(0, 50)}...
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* 4. File Visualization */}
        <Section title="4. Files">
          <Button onClick={refreshFileData}>🔄 Refresh Files</Button>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <FileGridCompact
              title={`addressing.bin (${formatBytes(addressingSize)})`}
              data={addressingData}
            />
            <FileGridCompact
              title={`data.bin (${formatBytes(dataSize)})`}
              data={dataFileData}
            />
          </div>
        </Section>

        {/* 5. Logs */}
        <Section title="5. Logs">
          <div
            style={{
              height: 150,
              overflow: 'auto',
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: 8,
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            {logs.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </Section>

        {/* 6. Debug */}
        <Section title="6. Debug">
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <Button onClick={handleCleanup} color="#868e96">
              🧹 Cleanup Worker
            </Button>
            <Button onClick={handleClearStorage} color="#dc3545">
              🗑️ Clear Storage
            </Button>
          </div>
          <p style={{ fontSize: 11, color: '#868e96' }}>
            <b>Cleanup</b>: Flush & close handles (before refresh).
            <br />
            <b>Clear</b>: Delete all data (for corruption).
          </p>
        </Section>
      </div>
    </div>
  );
}

// ============================================================
// COMPONENTS
// ============================================================

function StatusBar({ status }: { status: WorkerStatus | null }) {
  return (
    <div
      style={{
        marginBottom: 8,
        padding: 6,
        background: '#f0f0f0',
        borderRadius: 6,
        fontSize: 11,
        textAlign: 'center',
      }}
    >
      {status ? (
        <>
          {status.initialized ? '✅' : '❌'} Init{' '}
          {status.sessionUnlocked ? '🔓' : '🔒'} Session{' '}
          {status.dbOpen ? '✅' : '❌'} DB
        </>
      ) : (
        '⏳ Not connected'
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, marginBottom: 8, color: '#495057' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Button({
  onClick,
  children,
  color = '#4dabf7',
  fullWidth = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 10px',
        background: color,
        color: 'white',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 11,
        width: fullWidth ? '100%' : 'auto',
      }}
    >
      {children}
    </button>
  );
}

function FileGridCompact({
  title,
  data,
}: {
  title: string;
  data: Uint8Array | null;
}) {
  if (!data || data.length === 0) {
    return (
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, marginBottom: 2 }}>{title}</div>
        <div
          style={{
            width: '100%',
            height: 80,
            background: '#f0f0f0',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            color: '#999',
          }}
        >
          No data
        </div>
      </div>
    );
  }

  // Create a 32x32 grid (1024 cells)
  const gridSize = 32;
  const cellsToShow = gridSize * gridSize;
  const bytesPerCell = Math.max(1, Math.floor(data.length / cellsToShow));

  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, marginBottom: 2 }}>{title}</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
          gap: 0,
          background: '#000',
          borderRadius: 4,
          overflow: 'hidden',
          aspectRatio: '1',
        }}
      >
        {Array.from({ length: cellsToShow }).map((_, i) => {
          const byteIndex = i * bytesPerCell;
          const byte = byteIndex < data.length ? data[byteIndex] : 0;
          const gray = byte;

          return (
            <div
              key={i}
              style={{
                background: `rgb(${gray}, ${gray}, ${gray})`,
                aspectRatio: '1',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  marginRight: 6,
  marginBottom: 6,
  border: '1px solid #ced4da',
  borderRadius: 4,
  fontSize: 12,
  width: 120,
};
