import { defineConfig } from "vite";
import { loadViteDevConfig } from "@omnyo/config/vite-dev";
import { sharedViteConfig } from "./vite.config.js";

const viteDevConfig = loadViteDevConfig();

const devWebSocketBrowserHostPortDefine = JSON.stringify(
  viteDevConfig.serverPort,
);

export default defineConfig({
  ...sharedViteConfig,
  css: {
    transformer: "lightningcss",
  },
  define: {
    __OMNYO_DEV_WS_BROWSER_HOST_PORT__: devWebSocketBrowserHostPortDefine,
    __OMNYO_DEV_APP_BROWSER_HOST_PORT__: JSON.stringify(viteDevConfig.appPort),
  },
  server: {
    allowedHosts: [".ts.net"],
    cors: { preflightContinue: true },
    host: viteDevConfig.appHost,
    port: viteDevConfig.appPort,
    proxy: {
      "/preview": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
      "/api": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        xfwd: true,
      },
      "/health": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        xfwd: true,
      },
      "/ws": {
        target: viteDevConfig.serverHttpOrigin,
        changeOrigin: true,
        ws: true,
        xfwd: true,
      },
    },
  },
});
