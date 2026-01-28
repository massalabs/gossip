/* @ts-self-types="./gossip_storage.d.ts" */

/**
 * Create a new session with the given password
 * Returns true on success, false on failure
 * @param {string} password
 * @returns {boolean}
 */
export function createSession(password) {
  const ptr0 = passStringToWasm0(
    password,
    wasm.__wbindgen_malloc,
    wasm.__wbindgen_realloc
  );
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.createSession(ptr0, len0);
  return ret !== 0;
}

/**
 * Flush data blob to disk
 * @returns {boolean}
 */
export function flushData() {
  const ret = wasm.flushData();
  return ret !== 0;
}

/**
 * Get the current size of the data blob
 * @returns {bigint}
 */
export function getDataSize() {
  const ret = wasm.getDataSize();
  return BigInt.asUintN(64, ret);
}

/**
 * Get the root block address (for debugging)
 * @returns {bigint}
 */
export function getRootAddress() {
  const ret = wasm.getRootAddress();
  return BigInt.asUintN(64, ret);
}

/**
 * Get the root block length (for debugging)
 * @returns {number}
 */
export function getRootLength() {
  const ret = wasm.getRootLength();
  return ret >>> 0;
}

/**
 * Get WASM module version (for verification)
 * @returns {string}
 */
export function getWasmVersion() {
  let deferred1_0;
  let deferred1_1;
  try {
    const ret = wasm.getWasmVersion();
    deferred1_0 = ret[0];
    deferred1_1 = ret[1];
    return getStringFromWasm0(ret[0], ret[1]);
  } finally {
    wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
  }
}

/**
 * Initialize panic hook for better error messages
 */
export function init() {
  wasm.init();
}

/**
 * Initialize storage with random data (2MB addressing blob)
 * Must be called before any session operations
 */
export function initStorage() {
  wasm.initStorage();
}

/**
 * Check if a session is currently unlocked
 * @returns {boolean}
 */
export function isSessionUnlocked() {
  const ret = wasm.isSessionUnlocked();
  return ret !== 0;
}

/**
 * Lock the current session (zeroizes keys)
 */
export function lockSession() {
  wasm.lockSession();
}

/**
 * Read bytes from the data blob at the given offset
 * Used by Custom VFS for SQLite page reads
 * Returns empty array if session is locked
 * @param {bigint} offset
 * @param {number} len
 * @returns {Uint8Array}
 */
export function readData(offset, len) {
  const ret = wasm.readData(offset, len);
  var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v1;
}

/**
 * Test function for spike 0.3 - validates sync JS calls from WASM
 * Returns true if all tests pass
 * @returns {boolean}
 */
export function spikeTestSyncCalls() {
  const ret = wasm.spikeTestSyncCalls();
  return ret !== 0;
}

/**
 * Unlock an existing session with the given password
 * Returns true on success, false on failure (wrong password)
 * @param {string} password
 * @returns {boolean}
 */
export function unlockSession(password) {
  const ptr0 = passStringToWasm0(
    password,
    wasm.__wbindgen_malloc,
    wasm.__wbindgen_realloc
  );
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.unlockSession(ptr0, len0);
  return ret !== 0;
}

/**
 * Write bytes to the data blob at the given offset
 * Used by Custom VFS for SQLite page writes
 * Returns true on success, false if session is locked
 * @param {bigint} offset
 * @param {Uint8Array} data
 * @returns {boolean}
 */
export function writeData(offset, data) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.writeData(offset, ptr0, len0);
  return ret !== 0;
}

function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_is_function_0095a73b8b156f76: function (arg0) {
      const ret = typeof arg0 === 'function';
      return ret;
    },
    __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function (arg0) {
      const val = arg0;
      const ret = typeof val === 'object' && val !== null;
      return ret;
    },
    __wbg___wbindgen_is_string_cd444516edc5b180: function (arg0) {
      const ret = typeof arg0 === 'string';
      return ret;
    },
    __wbg___wbindgen_is_undefined_9e4d92534c42d778: function (arg0) {
      const ret = arg0 === undefined;
      return ret;
    },
    __wbg___wbindgen_memory_bd1fbcf21fbef3c8: function () {
      const ret = wasm.memory;
      return ret;
    },
    __wbg___wbindgen_throw_be289d5034ed271b: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_buffer_71667b1101df19da: function (arg0) {
      const ret = arg0.buffer;
      return ret;
    },
    __wbg_call_75b89300dd530ca6: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
      }, arguments);
    },
    __wbg_call_d68488931693e6ee: function () {
      return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
      }, arguments);
    },
    __wbg_crypto_86f2631e91b51511: function (arg0) {
      const ret = arg0.crypto;
      return ret;
    },
    __wbg_error_7534b8e9a36f1ab4: function (arg0, arg1) {
      let deferred0_0;
      let deferred0_1;
      try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
      } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
      }
    },
    __wbg_getRandomValues_b3f15fcbfabb0f8b: function () {
      return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
      }, arguments);
    },
    __wbg_globalThis_59c7794d9413986f: function () {
      return handleError(function () {
        const ret = globalThis.globalThis;
        return ret;
      }, arguments);
    },
    __wbg_global_04c81bad83a72129: function () {
      return handleError(function () {
        const ret = global.global;
        return ret;
      }, arguments);
    },
    __wbg_log_75cfa8f61236f615: function (arg0, arg1) {
      console.log(getStringFromWasm0(arg0, arg1));
    },
    __wbg_msCrypto_d562bbe83e0d4b91: function (arg0) {
      const ret = arg0.msCrypto;
      return ret;
    },
    __wbg_new_8a6f238a6ece86ea: function () {
      const ret = new Error();
      return ret;
    },
    __wbg_new_9ed4506807911440: function (arg0) {
      const ret = new Uint8Array(arg0);
      return ret;
    },
    __wbg_new_no_args_fe7e106c48aadd7e: function (arg0, arg1) {
      const ret = new Function(getStringFromWasm0(arg0, arg1));
      return ret;
    },
    __wbg_new_with_byte_offset_and_length_a51b517eb0e8fbf4: function (
      arg0,
      arg1,
      arg2
    ) {
      const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbg_new_with_length_3212948a458000db: function (arg0) {
      const ret = new Uint8Array(arg0 >>> 0);
      return ret;
    },
    __wbg_node_e1f24f89a7336c2e: function (arg0) {
      const ret = arg0.node;
      return ret;
    },
    __wbg_process_3975fd6c72f520aa: function (arg0) {
      const ret = arg0.process;
      return ret;
    },
    __wbg_randomFillSync_f8c153b79f285817: function () {
      return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
      }, arguments);
    },
    __wbg_require_b74f47fc2d022fd6: function () {
      return handleError(function () {
        const ret = module.require;
        return ret;
      }, arguments);
    },
    __wbg_self_c9a63b952bd22cbd: function () {
      return handleError(function () {
        const ret = self.self;
        return ret;
      }, arguments);
    },
    __wbg_set_e8d9380e866a1e41: function (arg0, arg1, arg2) {
      arg0.set(arg1, arg2 >>> 0);
    },
    __wbg_stack_0ed75d68575b0f3c: function (arg0, arg1) {
      const ret = arg1.stack;
      const ptr1 = passStringToWasm0(
        ret,
        wasm.__wbindgen_malloc,
        wasm.__wbindgen_realloc
      );
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg_storageFlush_541cb56460d721f0: function (arg0) {
      storageFlush(arg0 >>> 0);
    },
    __wbg_storageGetSize_0ca3d3d3c3f99f39: function (arg0) {
      const ret = storageGetSize(arg0 >>> 0);
      return ret;
    },
    __wbg_storageRead_a7976149192515e5: function (arg0, arg1, arg2, arg3) {
      const ret = storageRead(arg1 >>> 0, BigInt.asUintN(64, arg2), arg3 >>> 0);
      const ptr1 = passArray8ToWasm0(ret, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    },
    __wbg_storageWrite_d7ff87d9e083e56a: function (arg0, arg1, arg2, arg3) {
      storageWrite(
        arg0 >>> 0,
        BigInt.asUintN(64, arg1),
        getArrayU8FromWasm0(arg2, arg3)
      );
    },
    __wbg_subarray_361dcbbb6f7ce587: function (arg0, arg1, arg2) {
      const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
      return ret;
    },
    __wbg_versions_4e31226f5e8dc909: function (arg0) {
      const ret = arg0.versions;
      return ret;
    },
    __wbg_window_81304a10d2638125: function () {
      return handleError(function () {
        const ret = window.window;
        return ret;
      }, arguments);
    },
    __wbindgen_cast_0000000000000001: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1);
      return ret;
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    },
  };
  return {
    __proto__: null,
    './gossip_storage_bg.js': import0,
  };
}

function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (
    cachedUint8ArrayMemory0 === null ||
    cachedUint8ArrayMemory0.byteLength === 0
  ) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', {
  ignoreBOM: true,
  fatal: true,
});
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', {
      ignoreBOM: true,
      fatal: true,
    });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(
    getUint8ArrayMemory0().subarray(ptr, ptr + len)
  );
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === 'function' && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);

        if (
          validResponse &&
          module.headers.get('Content-Type') !== 'application/wasm'
        ) {
          console.warn(
            '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
            e
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case 'basic':
      case 'cors':
      case 'default':
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn(
        'using deprecated parameters for `initSync()`; pass a single object instead'
      );
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        'using deprecated parameters for the initialization function; pass a single object instead'
      );
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL('gossip_storage_bg.wasm', import.meta.url);
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === 'string' ||
    (typeof Request === 'function' && module_or_path instanceof Request) ||
    (typeof URL === 'function' && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
