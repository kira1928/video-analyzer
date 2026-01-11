/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly STANDALONE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*?inline' {
  const content: string;
  export default content;
}
