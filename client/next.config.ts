import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://s3.tradingview.com`,
  "frame-src 'self' https://s.tradingview.com https://www.tradingview.com",
  "connect-src 'self' https://api.binance.com https://*.tradingview.com wss://*.tradingview.com https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org https://mainnet.sorobanrpc.com https://horizon-testnet.stellar.org https://horizon.stellar.org wss:",
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  // The Docusaurus docs site is built into public/docs as a static export and
  // served from this same deployment under /docs. Next doesn't resolve a folder
  // request to its index.html, so map clean /docs URLs onto the static files.
  // `afterFiles` means real assets (js/css/img under /docs) are served directly;
  // only bare route paths fall through to these rewrites.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        // Docusaurus (trailingSlash:false) emits flat .html files, e.g.
        // /docs/architecture/protocol.html. Real assets (js/css/img) exist on
        // disk and are served before these afterFiles rewrites kick in.
        { source: "/docs", destination: "/docs/index.html" },
        { source: "/docs/:path+", destination: "/docs/:path+.html" },
      ],
      fallback: [],
    };
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
