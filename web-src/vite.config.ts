
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join, sep } from 'path'
import fs from 'fs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'serve-rust-root',
      configureServer(server) {
        // Serve project root at /rust-root for debugging
        server.middlewares.use('/rust-root', (req, res, next) => {
          // req.url is relative to the mount point (e.g. /src/lib.rs)
          if (!req.url) return next();

          const filePath = join(__dirname, '..', req.url);

          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            // Basic mime type handling if needed, but text/plain is usually fine for code
            res.setHeader('Content-Type', 'text/plain');
            fs.createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        });
      }
    }
  ],
  // 使用相对路径，支持部署到任意子目录
  base: './',
  build: {
    outDir: '../web',
    emptyOutDir: false,
    sourcemap: process.env.VITE_SOURCEMAP === 'true' ? 'inline' : false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      // 不要尝试打包 WASM 模块
      external: [/\/pkg\/.*/],
      output: {
        // Worker 使用 ES 模块格式
        format: 'es',
      },
    },
  },
  worker: {
    format: 'es',
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
