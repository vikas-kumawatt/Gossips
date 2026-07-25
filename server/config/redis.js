import Redis from "ioredis";

let client = null;
let _ready = false;

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function createClient() {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  redis.on("ready", () => {
    _ready = true;
    console.log("Redis connected");
  });

  redis.on("error", (err) => {
    if (_ready) console.error("Redis error:", err.code ?? err.message);
    _ready = false;
  });

  redis.on("close", () => {
    _ready = false;
  });

  redis.connect().catch(() => {
    // Redis unavailable on startup — app continues without cache
  });

  return redis;
}

export function getRedis() {
  if (!client) client = createClient();
  return client;
}

export function isRedisReady() {
  return _ready;
}
