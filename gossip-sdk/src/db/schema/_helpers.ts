import { customType } from 'drizzle-orm/sqlite-core';

// Custom blob type — wa-sqlite returns Uint8Array natively for BLOB columns.
// Drizzle's built-in blob mode converts to/from hex strings, which breaks
// with wa-sqlite's direct Uint8Array handling. This custom type passes through.
export const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'blob';
  },
  fromDriver(value) {
    return value;
  },
  toDriver(value) {
    return value;
  },
});
