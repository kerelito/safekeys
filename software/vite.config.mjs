import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_BACKEND_URL || "http://localhost:3000";
const proxiedPaths = [
  "/assets",
  "/auth",
  "/generate-code",
  "/deactivate-code",
  "/open-locker",
  "/release-all-lockers",
  "/lockers",
  "/system-status",
  "/users",
  "/rfid-items",
  "/panel-users",
  "/active-codes",
  "/logs",
  "/alerts",
  "/export",
  "/device",
  "/socket.io"
];

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "client-assets"
  },
  server: {
    proxy: Object.fromEntries(
      proxiedPaths.map(path => [
        path,
        {
          target: backendTarget,
          changeOrigin: true,
          ws: path === "/socket.io" || path === "/device"
        }
      ])
    )
  }
});
