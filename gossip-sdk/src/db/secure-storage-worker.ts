import * as Comlink from 'comlink';
import { SecureStorageWorkerApi } from './secure-storage-worker-api.js';

Comlink.expose(new SecureStorageWorkerApi());
