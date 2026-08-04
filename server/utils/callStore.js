import { getRedis, isRedisReady } from "../config/redis.js";

/**
 * Where a call in flight lives.
 *
 * This was two module-level `Map`s inside config/socket.js, which works exactly as long
 * as there is one server process. With two, a caller on instance A and a callee on
 * instance B don't see each other's calls at all: A holds the offer, B has never heard
 * of the callId, so `answerCall` returns silently and the ring times out at 45 seconds.
 * Nothing errors — it just never connects, which is the worst way for it to fail.
 *
 * Two backends behind one async interface:
 *
 *   Redis    when a server is reachable. Keys carry a TTL, so a process that dies
 *            mid-call doesn't strand its participants as permanently "in a call".
 *   in-memory otherwise, which is the single-instance and local-development case.
 *            config/redis.js is deliberately optional and the app runs without it.
 *
 * The interface is async either way. Making the memory backend pretend to be
 * synchronous would mean two call paths in socket.js, and the one nobody runs locally
 * is the one that breaks.
 *
 * Timers are *not* here — a `setTimeout` handle isn't serialisable and a timer has to
 * fire in a process. Whichever node armed one owns it; if that node dies, the TTLs below
 * are what eventually reclaim the state.
 */

/*
 * Long enough to outlive `MAX_CALL_MS` (4h) plus slack, so Redis never expires a call
 * that is genuinely still up — the in-process backstop timer is what ends those. This is
 * the floor under a crashed instance, not the normal path.
 */
const CALL_TTL_SECONDS = 5 * 60 * 60;

const key = {
  call: (callId) => `call:${callId}`,
  user: (userId) => `call:user:${userId}`,
  ringing: (userId) => `call:ringing:${userId}`,
};

/* ── in-memory backend ─────────────────────────────────────────────────────── */

const calls = new Map(); // callId -> call data
const byUser = new Map(); // userId -> callId
const ringingFor = new Map(); // receiverId -> Set<callId>

const memory = {
  async get(callId) {
    return calls.get(callId) || null;
  },
  async save(callData) {
    calls.set(callData.callId, callData);
  },
  async reserveCaller(userId, callId) {
    if (byUser.has(userId)) return false;
    byUser.set(userId, callId);
    return true;
  },
  async bindUser(userId, callId) {
    byUser.set(userId, callId);
  },
  async userCallId(userId) {
    return byUser.get(userId) || null;
  },
  async unbindUser(userId, onlyIfCallId = null) {
    if (onlyIfCallId && byUser.get(userId) !== onlyIfCallId) return;
    byUser.delete(userId);
  },
  async addRinging(receiverId, callId) {
    if (!ringingFor.has(receiverId)) ringingFor.set(receiverId, new Set());
    ringingFor.get(receiverId).add(callId);
  },
  async ringingIds(receiverId) {
    return [...(ringingFor.get(receiverId) || [])];
  },
  async removeRinging(receiverId, callId) {
    const set = ringingFor.get(receiverId);
    if (!set) return;
    set.delete(callId);
    if (!set.size) ringingFor.delete(receiverId);
  },
  async remove(callId) {
    calls.delete(callId);
  },
};

/* ── Redis backend ─────────────────────────────────────────────────────────── */

const redis = {
  async get(callId) {
    const raw = await getRedis().get(key.call(callId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // Dates survive JSON as strings; `endCall` subtracts `createdAt` from a Date and
      // `saveCallLog` stores them, so they have to come back as Dates or the duration is
      // NaN and the call log's timestamps are wrong.
      for (const field of ["createdAt", "answeredAt", "endedAt", "rejectedAt"]) {
        if (parsed[field]) parsed[field] = new Date(parsed[field]);
      }
      return parsed;
    } catch {
      return null;
    }
  },
  async save(callData) {
    await getRedis().set(
      key.call(callData.callId),
      JSON.stringify(callData),
      "EX",
      CALL_TTL_SECONDS
    );
  },
  async reserveCaller(userId, callId) {
    // `NX`, so two tabs dialling at the same moment can't both pass the
    // "you're already in a call" check — the second reservation simply fails.
    const result = await getRedis().set(
      key.user(userId),
      callId,
      "EX",
      CALL_TTL_SECONDS,
      "NX"
    );
    return result === "OK";
  },
  async bindUser(userId, callId) {
    await getRedis().set(key.user(userId), callId, "EX", CALL_TTL_SECONDS);
  },
  async userCallId(userId) {
    return (await getRedis().get(key.user(userId))) || null;
  },
  async unbindUser(userId, onlyIfCallId = null) {
    if (!onlyIfCallId) {
      await getRedis().del(key.user(userId));
      return;
    }
    // Only clear the pointer if it still points at *this* call, or ending an old call
    // detaches the user from a newer one. Read-then-delete rather than a Lua script: the
    // window is microseconds and the failure mode is a stale pointer that its own TTL
    // clears, not a wrong call being torn down.
    const current = await getRedis().get(key.user(userId));
    if (current === onlyIfCallId) await getRedis().del(key.user(userId));
  },
  async addRinging(receiverId, callId) {
    const client = getRedis();
    await client.sadd(key.ringing(receiverId), callId);
    await client.expire(key.ringing(receiverId), CALL_TTL_SECONDS);
  },
  async ringingIds(receiverId) {
    return (await getRedis().smembers(key.ringing(receiverId))) || [];
  },
  async removeRinging(receiverId, callId) {
    await getRedis().srem(key.ringing(receiverId), callId);
  },
  async remove(callId) {
    await getRedis().del(key.call(callId));
  },
};

/*
 * Chosen per operation, not once at startup.
 *
 * Redis here is optional and connects lazily, so it can become ready after the first
 * call and can drop out mid-process. Picking a backend once would either miss a server
 * that arrived late or keep using one that has gone away.
 *
 * The cost is that state written to one backend is invisible to the other, so a call in
 * progress when Redis drops is lost — it ends rather than continuing wrongly, which for
 * a call is the right way round.
 */
const backend = () => (isRedisReady() ? redis : memory);

/**
 * Record a new outgoing call.
 *
 * @returns true if it was recorded, false if the caller was already in one — the check
 * and the reservation are one atomic step, so this doubles as the "you're already in a
 * call" guard rather than being a separate read the caller has to trust.
 */
export const createCall = async (callData) => {
  const store = backend();
  if (!(await store.reserveCaller(callData.caller, callData.callId))) return false;
  await store.save(callData);
  /*
   * The callee is indexed as *ringing*, not reserved.
   *
   * Reserving them while their phone merely rings would let one caller hold someone in a
   * rolling 45-second lockout, and would break two people dialling each other at the
   * same moment. The index exists because a callee who closes the tab mid-ring has to be
   * findable: the single-process version scanned every live call, which Redis can't do.
   */
  await store.addRinging(callData.receiver, callData.callId);
  return true;
};

export const getCall = async (callId) =>
  typeof callId === "string" && callId ? backend().get(callId) : null;

/** Persist a mutated call. In-memory this is a no-op on the same object; in Redis it isn't. */
export const saveCall = async (callData) => {
  if (callData?.callId) await backend().save(callData);
};

export const getUserCallId = async (userId) => backend().userCallId(userId);

/** Reserve the callee, once they've actually picked up. */
export const bindUserToCall = async (userId, callId) =>
  backend().bindUser(userId, callId);

export const unbindUser = async (userId) => backend().unbindUser(userId);

/** Every call currently ringing *at* this user. */
export const getRingingCallsFor = async (userId) => {
  const store = backend();
  const ids = await store.ringingIds(userId);
  const found = await Promise.all(ids.map((id) => store.get(id)));

  return found.filter((callData, index) => {
    if (!callData || callData.status !== "ringing") {
      // A dangling index entry, from a call that ended without passing through
      // `removeCall` — or one whose TTL expired. Swept on read.
      store.removeRinging(userId, ids[index]).catch(() => {});
      return false;
    }
    return true;
  });
};

/** Forget a call, and detach both parties from it. */
export const removeCall = async (callData) => {
  if (!callData?.callId) return;
  const store = backend();
  await Promise.all([
    store.remove(callData.callId),
    store.unbindUser(callData.caller, callData.callId),
    store.unbindUser(callData.receiver, callData.callId),
    store.removeRinging(callData.receiver, callData.callId),
  ]);
};

/** Test seam: the in-memory backend keeps state across a test file otherwise. */
export const __resetMemory = () => {
  calls.clear();
  byUser.clear();
  ringingFor.clear();
};
