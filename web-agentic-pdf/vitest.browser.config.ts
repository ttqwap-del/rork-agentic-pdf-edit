import path from "path";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['vitest-browser-react', 'react', 'react-dom/client', 'react/jsx-runtime', 'react-pageflip', 'lucide-react', 'pdf-lib'] },
  envPrefix: ['VITE_', 'EXPO_PUBLIC_'],
  test: {
    globals: true,
    include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
    browser: {
      enabled: true,
      screenshotFailures: false,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
