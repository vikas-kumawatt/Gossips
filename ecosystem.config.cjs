/**
 * PM2 process definitions for the EC2 host.
 *
 * This was not in the repository. It lived only on the box, which means the
 * production process topology — modes, memory ceilings, restart behaviour — was
 * knowable only by SSHing in, and rebuilding the instance meant rediscovering it.
 * Checking it in also lets `pm2 reload ecosystem.config.cjs` be the deploy step,
 * so a change to how a process runs ships the same way a code change does.
 *
 *   pm2 start ecosystem.config.cjs        # first time
 *   pm2 reload ecosystem.config.cjs       # after a deploy
 *   pm2 save                              # persist across reboots
 *
 * `.cjs` because PM2 requires CommonJS here, and the root package.json is
 * currently CJS by omission — an explicit extension means adding
 * `"type": "module"` later cannot silently break the deploy.
 */

module.exports = {
  apps: [
    {
      /*
       * These names must match what `pm2 list` already shows on the box.
       *
       * PM2 keys processes by name, so a rename is not a rename — `pm2 reload`
       * starts a *second* process under the new name and leaves the old one
       * running. Both then bind port 5000: the newcomer loses, exits, and the
       * stale process keeps serving. The deploy's health check would pass,
       * because something is answering on 5000, and every subsequent deploy
       * would appear to succeed while shipping nothing.
       */
      name: "gossips-node",
      cwd: "./server",
      script: "server.js",

      /*
       * Fork mode with exactly one instance, and this is not a placeholder to
       * tune later — it is a correctness requirement.
       *
       * Cluster mode would run several workers behind PM2's load balancer, and
       * this server keeps per-user state in process memory: the socket registry
       * in config/socket.js, the socket rate-limit buckets, the WebRTC call
       * timers, and the per-user send-ordering chains. Two workers means two
       * users connected to the same conversation can land in different processes
       * and never see each other's messages — silently, and only under load.
       *
       * The fix for that is the Redis adapter (already imported, currently with
       * no reachable Redis), not more workers. Until REDIS_URL resolves, one
       * instance is the only correct setting.
       */
      instances: 1,
      exec_mode: "fork",

      /*
       * A 1 GB box with Atlas and no Redis. If the process reaches this, PM2
       * restarts it rather than letting the kernel choose a victim — and the
       * kernel's choice is often sshd, which turns a leak into a console session.
       */
      max_memory_restart: "400M",

      autorestart: true,
      /*
       * A process that dies within 10s of starting is failing at boot, not
       * crashing under load, and restarting it in a tight loop obscures the
       * error. `ALLOWED_ORIGINS` unset in production does exactly this.
       */
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,

      // NODE_ENV drives the cookie flags: production means Secure and
      // SameSite=None, which the cross-origin Netlify client requires. Every
      // other value lives in server/.env and is read by dotenv at boot.
      env: {
        NODE_ENV: "production",
      },

      /*
       * Combined into one file, timestamped. PM2 does not rotate on its own —
       * install pm2-logrotate once per box or this fills the disk:
       *   pm2 install pm2-logrotate
       *   pm2 set pm2-logrotate:max_size 10M
       *   pm2 set pm2-logrotate:retain 5
       */
      merge_logs: true,
      time: true,
    },

    {
      // Matching the box, as above.
      name: "gossips-python",
      cwd: "./python-service",

      /*
       * Through run.sh rather than invoking uvicorn directly, so the bind
       * address, port and worker count stay in one place — that file explains
       * why it is 127.0.0.1 and one worker, and duplicating the flags here is
       * how the two drift.
       *
       * `interpreter: "bash"` rather than relying on the shebang: a checkout
       * from Windows does not reliably carry the executable bit.
       *
       * If uvicorn is inside a virtualenv, put its bin on PATH here — otherwise
       * run.sh resolves the system uvicorn, or none at all:
       *   env: { PATH: `${process.env.HOME}/.venvs/gossips/bin:${process.env.PATH}` }
       */
      script: "run.sh",
      interpreter: "bash",

      instances: 1,
      exec_mode: "fork",

      // One uvicorn worker holding a decrypted key per in-flight request. Small,
      // and a ceiling here leaves the API room on a 1 GB box.
      max_memory_restart: "200M",

      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,

      merge_logs: true,
      time: true,
    },
  ],
};
