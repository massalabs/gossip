export async function walOpfsOpenDir(name) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

export async function walOpfsOpenSync(dir, fileName) {
  const file = await dir.getFileHandle(fileName, { create: true });
  return file.createSyncAccessHandle();
}

export function walOpfsRead(handle, offset, length) {
  const buf = new Uint8Array(length);
  handle.read(buf, { at: offset });
  return buf;
}

export function walOpfsWrite(handle, offset, data) {
  handle.write(data, { at: offset });
}

export function walOpfsFlush(handle) {
  handle.flush();
}

export function walOpfsGetSize(handle) {
  return handle.getSize();
}

export function walOpfsTruncate(handle, size) {
  handle.truncate(size);
}

export function walOpfsClose(handle) {
  handle.close();
}
