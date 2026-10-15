import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const localControlPlaneTarget =
    process.env.SCREENHAND_LOCAL_CONTROL_PLANE_URL ?? "http://127.0.0.1:3013";
  const localAutoSetupTarget =
    process.env.SCREENHAND_AUTO_SETUP_URL ?? "http://127.0.0.1:3031";
  const localRealtimeAgentTarget =
    process.env.SCREENHAND_REALTIME_URL ?? "http://127.0.0.1:3024";

  return {
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      proxy: {
        "/task-console-api": {
          target: process.env.SCREENHAND_TASK_CONSOLE_URL ?? "http://127.0.0.1:3027",
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/task-console-api/, ""),
        },
        "/local-perception-api": {
          target: process.env.SCREENHAND_PERCEPTION_URL ?? "http://127.0.0.1:3026",
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/local-perception-api/, ""),
        },
        "/realtime-agent-api": {
          target: localRealtimeAgentTarget,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/realtime-agent-api/, ""),
        },
        "/auto-setup-api": {
          target: localAutoSetupTarget,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/auto-setup-api/, ""),
        },
        "/api": {
          target: localControlPlaneTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
