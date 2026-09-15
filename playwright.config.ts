import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3108', channel: 'chrome', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npm run dev', url: 'http://127.0.0.1:3108/api/health', reuseExistingServer: false,
    env: { PORT: '3108', CLINGRAPH_STORAGE: 'sqlite', CLINGRAPH_DB_PATH: path.resolve('data/browser-test.sqlite'), CLINGRAPH_AI_CONCURRENCY: '4', GEMINI_API_KEY: '', UMLS_API_KEY: '' },
  },
});
