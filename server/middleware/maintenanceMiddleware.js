import { getSettings } from "../utils/settings.js";

// Staff must still be able to sign in and turn maintenance back off, so auth
// and the admin panel stay reachable. Reads are allowed through; only writes
// are blocked, which keeps the app browsable while it's frozen.
const ALWAYS_ALLOWED = ["/auth", "/admin"];

/**
 * Blocks mutating requests while maintenance mode is on. Mounted before the
 * feature routes in server.js.
 */
export const maintenanceGate = async (req, res, next) => {
  try {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    if (ALWAYS_ALLOWED.some((prefix) => req.path.startsWith(prefix))) return next();

    const settings = await getSettings();
    if (!settings.maintenanceMode) return next();

    return res.status(503).json({
      error: settings.maintenanceMessage,
      maintenance: true,
    });
  } catch (error) {
    // Never let a settings lookup take the API down.
    console.error("maintenanceGate error:", error);
    return next();
  }
};
