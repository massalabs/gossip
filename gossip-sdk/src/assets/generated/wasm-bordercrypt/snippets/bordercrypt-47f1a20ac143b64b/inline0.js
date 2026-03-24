
export async function opfsOpenDir(name) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(name, { create: true });
}

export async function opfsOpenSync(dir, fileName) {
    const file = await dir.getFileHandle(fileName, { create: true });
    return file.createSyncAccessHandle();
}

export function opfsRead(handle, offset, length) {
    const buf = new Uint8Array(length);
    handle.read(buf, { at: offset });
    return buf;
}

export function opfsWrite(handle, offset, data) {
    handle.write(data, { at: offset });
}

export function opfsFlush(handle) {
    handle.flush();
}

export function opfsGetSize(handle) {
    return handle.getSize();
}

export function opfsTruncate(handle, size) {
    handle.truncate(size);
}

export function opfsClose(handle) {
    handle.close();
}
