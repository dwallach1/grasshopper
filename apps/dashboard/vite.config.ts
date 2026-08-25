import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

/** Secrets Store, Workers AI, and Hyperdrive need Cloudflare login; local Miniflare uses `.dev.vars`. */
function withoutRemoteOnlyBindings<
  Config extends { secrets_store_secrets?: unknown; ai?: unknown; hyperdrive?: unknown },
>(userConfig: Config): void {
  delete userConfig.secrets_store_secrets;
  delete userConfig.ai;
  delete userConfig.hyperdrive;
}

type DashboardDevServer = {
  host: string;
  port: number;
  watch?: { useFsEvents: boolean; usePolling: boolean };
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  const server: DashboardDevServer = {
    host: '127.0.0.1',
    port: 5173,
  };
  if (isCodexSeatbeltSandbox) {
    server.watch = { useFsEvents: false, usePolling: true };
  }

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        configPath: './wrangler.jsonc',
        config: withoutRemoteOnlyBindings,
        auxiliaryWorkers: [
          {
            configPath: '../../workers/knowledge/wrangler.jsonc',
            config: withoutRemoteOnlyBindings,
          },
        ],
      }),
    ],
  };
});
