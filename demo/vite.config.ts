import { defineConfig } from "vite";

import { orchestratorApi } from "./server/plugin.js";

/**
 * Bound to `127.0.0.1` and not to `localhost`: the name can resolve to the
 * IPv6 loopback first, and the Ollama daemon this demo may be talking to binds
 * the other one. modelpact's Ollama config carries the same note.
 *
 * There is no `build` script. The orchestrator runs in Node — it spawns
 * `claude` — so the dev server is not scaffolding around a static page, it is
 * half the demo.
 */
export default defineConfig({
  plugins: [orchestratorApi()],
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
});
