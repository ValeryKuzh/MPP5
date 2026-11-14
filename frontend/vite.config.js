import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В режиме разработки /graphql (HTTP и WebSocket) проксируется на шлюз
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': { target: process.env.GATEWAY_URL || 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
});
