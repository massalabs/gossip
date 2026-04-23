/**
 * Pre-fetch a WASM asset via XHR and wrap it in a blob URL.
 *
 * Safari (notably iOS 18 and some desktop builds) has a long-standing bug with
 * responses that use `Transfer-Encoding: chunked` without a `Content-Length`
 * header: `fetch().arrayBuffer()` can return truncated or empty data. DeWeb
 * and some CDN gateways serve .wasm files this way, which causes
 * `WebAssembly.instantiate()` to fail in the SQLite worker with an opaque
 * "SQLite not initialized" error.
 *
 * XHR with `responseType = 'arraybuffer'` handles chunked responses correctly
 * on Safari where fetch() doesn't. We load the bytes once, wrap them in a
 * blob URL, and hand that URL to the SDK — subsequent `fetch(blobUrl)` calls
 * read from memory and bypass the network layer entirely.
 */
export async function preloadWasmAsBlobUrl(url: string): Promise<string> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        resolve(xhr.response as ArrayBuffer);
      } else {
        reject(new Error(`WASM preload failed: HTTP ${xhr.status} for ${url}`));
      }
    };
    xhr.onerror = () =>
      reject(new Error(`WASM preload network error for ${url}`));
    xhr.send();
  });
  return URL.createObjectURL(new Blob([buffer], { type: 'application/wasm' }));
}
