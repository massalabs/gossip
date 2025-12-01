// console log test
import { vi } from 'vitest';

type ConsoleMethod = 'log' | 'error' | 'warn' | 'info' | 'debug';

export const consoleMock = (method: ConsoleMethod) =>
  vi.spyOn(console, method).mockImplementation(() => undefined);

// clear
export const consoleClearMock = (method: ConsoleMethod) => {
  vi.spyOn(console, method).mockClear();
};
