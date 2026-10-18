import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // 本地 factory-3d 组件库（构建产物 ES 模块，依赖安装后即可用）
      'factory-3d': fileURLToPath(new URL('./src/factory-3d/factory-3d.es.js', import.meta.url)),
    },
  },
  define: {
    'process.env.DRAGGABLE_DEBUG': 'false',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'antd-vendor': ['antd', '@ant-design/icons', '@ant-design/pro-components'],
          'supabase-vendor': ['@supabase/supabase-js'],
        },
      },
    },
  },
})
