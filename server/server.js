import "./config/config.js";
import express from "express";
import mongoose from "mongoose";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import commentRoutes from "./routes/commentRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import groupRoutes from "./routes/groupRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";
import attachmentRoutes from "./routes/attachmentRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import botRoutes from "./routes/botRoutes.js";
import { maintenanceGate } from "./middleware/maintenanceMiddleware.js";
import { sanitizeMongo } from "./middleware/sanitizeMongo.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { signingSecret } from "./utils/signingSecret.js";
import { backfillRoles } from "./utils/roles.js";
import { startScheduler } from "./utils/scheduler.js";
import { startBotRunner } from "./bots/runner.js";
import { startDmResponder } from "./bots/dmResponder.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { initializeSocket, getIO } from "./config/socket.js";
import { ALLOWED_ORIGINS } from "./config/origins.js";
import hashtagRoutes from "./routes/hashtagRoutes.js";
import { MulterError } from "multer";
import { unlink } from "fs";
import { MAX_FILE_SIZE, UNSUPPORTED_FILE_TYPE } from "./config/multerConfig.js";

const app = express();

/*
 * Render (and any CDN) terminates the connection, so without this every
 * request reports the edge's address as req.ip — and the rate limiters key on
 * that, turning a per-user limit into a platform-wide one. 1 = trust exactly
 * one hop, which is what a single reverse proxy warrants; trusting all hops
 * would let a client forge its own address via X-Forwarded-For.
 */
/*
 * Fail here rather than per-request.
 *
 * `signingSecret()` throws when JWT_SECRET is unset — correct, but it is called
 * on the request path by `verifyMedia` and `verifyUnlockGrant`, so an instance
 * booted without the variable would answer 500s to sends and to locked-chat
 * reads while looking healthy everywhere else. Touching it once at startup turns
 * that into a refusal to boot, which is the same bargain config/origins.js makes
 * for ALLOWED_ORIGINS.
 */
signingSecret();

app.set("trust proxy", 1);

/*
 * Express advertises itself on every response otherwise. It tells an attacker
 * which stack to aim at and tells a user nothing.
 */
app.disable("x-powered-by");

/*
 * Before CORS and before routing, so it applies to preflights, 404s and the
 * error handler as well as to successful responses.
 */
app.use(securityHeaders);

// Shared with the CSRF guard on the auth routes — see config/origins.js.
const allowedOrigins = ALLOWED_ORIGINS;

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.log("Blocked by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      // Device hints for "Based in" — the last resort when neither a CDN
      // header nor an IP lookup resolved a country. See utils/geo.js.
      "X-Client-Timezone",
      "X-Client-Locale",
      // Names the browser so a session row can mean "this account on this
      // device". Not a credential — see requestDeviceId in authController.
      "X-Device-Id",
      // The short-lived grant proving a chat lock PIN was entered. A header
      // rather than a query parameter so it stays out of access logs — see
      // utils/chatLock.js.
      "X-Chat-Unlock",
    ],
    /*
     * Those two custom headers ride on every request, which makes even an
     * anonymous GET a preflighted one. Chrome's default preflight cache is
     * about five seconds; a day means the browser asks once.
     */
    maxAge: 86400,
  })
);

app.use(express.json());
app.use(cookieParser());
// Must run before any route: strips `$`-prefixed and dotted keys so a client
// can't smuggle a Mongo operator into a query filter.
app.use(sanitizeMongo);

/*
 * Multer writes the upload to uploads/ before any handler runs, and the only
 * unlink in the codebase is the one inside uploadToCloudinary — so every early
 * return that happens first (wrong type, not a member of the group, no such
 * conversation) strands the file on disk. Doing this per branch would mean
 * remembering it at a few dozen return statements and getting it wrong at one
 * of them; hanging it off the response instead means it runs once per request
 * whatever the outcome, including the ones that throw. ENOENT is the ordinary
 * case rather than a failure: a request that reached Cloudinary has already
 * had its temp file removed there.
 */
app.use((req, res, next) => {
  /*
   * `close`, not `finish`.
   *
   * `finish` fires only when a response was fully sent, so an upload the
   * client abandons — tab closed, connection dropped — after multer has
   * written the file but before the handler answers leaves it on disk
   * permanently. `close` fires on both paths, and the flag stops the two from
   * double-unlinking when they both do.
   */
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    const files = Array.isArray(req.files)
      ? [...req.files]
      : req.files
      ? Object.values(req.files).flat()
      : [];
    if (req.file) files.push(req.file);

    for (const file of files) {
      if (!file?.path) continue;
      unlink(file.path, (err) => {
        if (err && err.code !== "ENOENT") {
          console.error("Failed to remove temp upload:", file.path, err);
        }
      });
    }
  };

  res.on("finish", cleanup);
  res.on("close", cleanup);
  next();
});

const server = createServer(app);

const io = initializeSocket(server);
export { io, getIO };

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB Connected");
    // `role` was added after accounts existed; give every document the field.
    return backfillRoles();
  })
  .then(() => {
    // Started only after the connection is up. Its first tick doubles as the
    // catch-up sweep for anything that came due while the server was down.
    startScheduler();

    /*
     * The AI bot loop and the fast DM reply path. Both no-ops unless
     * BOTS_ENABLED=true, so an environment without the Python reasoning
     * service — or a staging copy of production data, where bots spending real
     * money would be a bad surprise — runs exactly as it does today.
     *
     * Not awaited: `startBotRunner` probes the reasoning service, and a slow or
     * absent probe must not delay the rest of boot. It logs its own outcome.
     */
    startDmResponder();
    startBotRunner().catch((error) =>
      console.error("Bot runner failed to start:", error?.message ?? error)
    );
  })
  .catch((err) => console.error("MongoDB Error:", err));

// Freezes writes when maintenance mode is on; auth and /admin stay reachable
// so staff can turn it back off.
app.use(maintenanceGate);

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/user", userRoutes);
app.use("/posts", postRoutes);
app.use("/reply", commentRoutes);
app.use("/notification", notificationRoutes);
app.use("/chats", messageRoutes);
app.use("/groups", groupRoutes);
app.use("/reports", reportRoutes);
app.use("/schedule", scheduleRoutes);
app.use("/tags", hashtagRoutes);
// Poll voting and place search — shared by the composer and the feed.
app.use("/attachments", attachmentRoutes);
// Content search (posts + replies) and recent-search history.
app.use("/search", searchRoutes);
// Owner-managed AI bot accounts and the BYOK keys that pay for them.
app.use("/bots", botRoutes);

app.get("/", (req, res) => {
  res.send("Server is running");
});

/*
 * Express 4 hands an error to the first middleware declared with four
 * arguments, which is why this sits below every mount — registered any earlier
 * and the routes above it would never reach it. There was no such handler at
 * all, so a multer rejection (an unsupported type, or a file over the limit)
 * fell through to Express's default and came back as an HTML 500 page; a
 * client expecting JSON can only report that as a parse failure, never as
 * "your file is too big".
 *
 * Multer's own messages are safe to pass on — they describe the request, not
 * the server. Everything else is logged here and answered with a fixed string,
 * because err.message on an unexpected fault routinely carries a file path, a
 * stack frame or the driver's view of a failed query. The status is preserved
 * where the error carries one, so a malformed JSON body still answers 400
 * rather than being relabelled a server fault.
 */
app.use((err, req, res, _next) => {
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`
        : err.message;
    return res.status(400).json({ error: message });
  }

  if (err?.code === UNSUPPORTED_FILE_TYPE) {
    return res.status(400).json({ error: err.message });
  }

  console.error("Unhandled error:", err);
  const status = err?.status || err?.statusCode || 500;
  res
    .status(status)
    .json({ error: status < 500 ? "Bad request" : "Something went wrong" });
});

/*
 * `PORT` from the environment, 5000 otherwise.
 *
 * The port was the literal 5000 and `PORT` was read nowhere, which meant every
 * platform that assigns a port by injecting that variable — Render, Heroku, Fly,
 * Cloud Run, most PaaS — could only work by coincidence. The old log line also
 * announced a specific machine's LAN address (`192.168.234.133`), hardcoded, so
 * in production it printed an address the server was not reachable on.
 *
 * `Number(...)` because the environment hands over strings and `listen` accepts
 * one, but a string port silently changes how the value is interpreted; `|| PORT`
 * covers unset, empty and unparseable in one step.
 */
const PORT = Number(process.env.PORT) || 5000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
