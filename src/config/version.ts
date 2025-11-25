import packageJson from '../../package.json';

export const APP_VERSION = packageJson.version;
export const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID ?? 'dev-local';
