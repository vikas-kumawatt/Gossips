/**
 * The web origins this API serves.
 *
 * One list, because two copies drift: CORS decides whether a browser may read
 * a response, and the CSRF guard on the auth routes decides whether a
 * state-changing request is even accepted. Those must agree, or one of them is
 * quietly not doing its job.
 */
export const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://gossipsss.netlify.app",
];

export const isAllowedOrigin = (origin) => ALLOWED_ORIGINS.includes(origin);
