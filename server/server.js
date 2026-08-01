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
import { maintenanceGate } from "./middleware/maintenanceMiddleware.js";
import { sanitizeMongo } from "./middleware/sanitizeMongo.js";
import { backfillRoles } from "./utils/roles.js";
import { startScheduler } from "./utils/scheduler.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { initializeSocket, getIO, getUserSocket } from "./config/socket.js";

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://gossipsss.netlify.app",
];

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
const server = createServer(app);

const io = initializeSocket(server);
export { io, getIO, getUserSocket };

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
// Poll voting and place search — shared by the composer and the feed.
app.use("/attachments", attachmentRoutes);
// Content search (posts + replies) and recent-search history.
app.use("/search", searchRoutes);

app.get("/", (req, res) => {
  res.send("Server is running");
});

server.listen(5000, () => {
  console.log("Server running on port 5000 at 192.168.234.133");
});
