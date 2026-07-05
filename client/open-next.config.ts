// OpenNext → Cloudflare adapter config.
// Defaults are correct for this app: API routes run in the Worker (Node.js
// runtime APIs via nodejs_compat), static assets are served from the ASSETS
// binding, and ISR/cache can later be backed by R2 if needed.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
