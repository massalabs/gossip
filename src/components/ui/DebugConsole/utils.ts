export const formatTime = (iso: string): string => {
  const d = new Date(iso);
  const hrs = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  const secs = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${hrs}:${mins}:${secs}.${ms}`;
};

export const formatLogMessage = (msg: unknown): string => {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return typeof msg[0] === 'string'
      ? msg[0]
      : JSON.stringify(msg[0], null, 2);
  }
  return JSON.stringify(msg, null, 2);
};
