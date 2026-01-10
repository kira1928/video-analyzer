import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 使用相对路径，支持部署到任意子目录
  base: './',
  build: {
    outDir: '../web',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      // 不要尝试打包 WASM 模块
      external: [/\/pkg\/.*/],
    },
  },
  resolve: {
    alias: {
      // 映射 /pkg 到 web/pkg 目录
      '/pkg': resolve(__dirname, '../web/pkg'),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    exclude: ['video_analyzer'],
  },
})
