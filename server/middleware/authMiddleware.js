import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { JWT_VERIFY_OPTIONS } from "../config/jwt.js";

// Attaches req.user if a valid Bearer token is present; otherwise continues unauthenticated.
export const optionalProtect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
        if (decoded.typ !== "refresh") {
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
      decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
    } catch {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }

    // A refresh token must not authenticate ordinary requests — it outlives
    // suspensions and forced sign-outs by days. Tokens issued before the `typ`
    // claim existed have no `typ`, so only an explicit "refresh" is rejected.
    if (decoded.typ === "refresh") {
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
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
