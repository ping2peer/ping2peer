import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  base: "./",
  plugins: [react(), basicSsl()],
  server: {
    proxy: {
      "/ping2peer-signal": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      }
    }
  }
});
