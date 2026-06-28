/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_RELAY_TOKEN?: string;
  readonly VITE_DEVICE_ID?: string;
  readonly VITE_SESSION_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
