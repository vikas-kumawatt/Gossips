import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { JWT_VERIFY_OPTIONS, isAccessToken, getAccessTokenSecret } from "../config/jwt.js";
import { isTokenRevoked } from "../utils/tokenRevocation.js";

// Attaches req.user if a valid Bearer token is present; otherwise continues unauthenticated.
export const optionalProtect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      try {
        const decoded = jwt.verify(token, getAccessTokenSecret(), JWT_VERIFY_OPTIONS);
        if (isAccessToken(decoded) && !(await isTokenRevoked(token))) {
          const user = await User.findById(decoded.id).select("-password");
          if (user) req.user = user;
        }
      } catch {
        // invalid/expired token — proceed as unauthenticated
      }
    }
    next();
  } catch {
    next();
  }
};

export const protect = async (req, res, next) => {
  try {
    let token = req.headers.authorization;

    if (!token || !token.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Unauthorized: No token provided" });
    }

    token = token.split(" ")[1];
    let decoded;

    try {
      decoded = jwt.verify(token, getAccessTokenSecret(), JWT_VERIFY_OPTIONS);
    } catch {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    // Only an access token authenticates an ordinary request. A refresh token
    // outlives suspensions and forced sign-outs by days; an email-verification
    // ticket belongs to an account that has not proved it owns its address.
    // See `isAccessToken` for why this is an allow-list.
    if (!isAccessToken(decoded)) {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    // Revocation check: blocks logged out or explicitly revoked access tokens immediately
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ message: "Unauthorized: Token has been revoked" });
    }

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    // Deleted and deactivated accounts keep a valid token until it expires.
    // Suspended accounts are handled per-route by requireActiveAccount, so a
    // suspended user can still read and see why they're blocked.
    if (["deleted", "deactivated"].includes(user.accountStatus)) {
      return res.status(401).json({ message: "Unauthorized: Account unavailable" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
};
