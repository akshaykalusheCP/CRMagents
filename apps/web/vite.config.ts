import react from '@vitejs/plugin-react';
import { loadEnv, defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const target = `http://localhost:${env.PORT ?? 3001}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target },
        '/oauth': { target },
      },
    },
  };
});
