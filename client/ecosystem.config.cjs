// PM2 ecosystem config — runs all Kryon background services.
// Usage: pm2 start ecosystem.config.cjs
//        pm2 stop all
//        pm2 logs
//        pm2 monit

module.exports = {
  apps: [
    {
      name: "kryon-oracle",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/oracle-keeper.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/oracle.log",
      error_file: "./logs/oracle.error.log",
    },
    {
      name: "kryon-matcher",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/matcher-service.ts",
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/matcher.log",
      error_file: "./logs/matcher.error.log",
    },
    {
      name: "kryon-indexer",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/state-indexer.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/indexer.log",
      error_file: "./logs/indexer.error.log",
    },
    {
      name: "kryon-ws",
      script: "npx",
      args: "tsx --env-file=.env.local scripts/ws-server.ts",
      cwd: __dirname,
      env: { PORT: "8080" },
      restart_delay: 3000,
      max_restarts: 20,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/ws.log",
      error_file: "./logs/ws.error.log",
    },
  ],
};
