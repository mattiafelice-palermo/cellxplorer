/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CELLXPLORER_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
