import { EventEmitter } from "node:events";

/**
 * A tiny in-process event bus, for one specific problem: import cycles.
 *
 * A bot has to reply when someone messages it, and the only path that creates a direct message is
 * `services/directMessage.js`. Wiring that directly means `directMessage.js` imports
 * `bots/dmResponder.js`, which imports `directMessage.js` to send the reply — a cycle. ESM
 * tolerates cycles until it doesn't: the failure is a partially-initialised module surfacing as
 * `undefined is not a function` at the moment a real user sends a real message.
 *
 * An emitter breaks it in the right direction. The service announces what happened and knows
 * nothing about who cares; the responder subscribes at startup. It is also the right *shape* for
 * this: a bot replying is not part of sending a message, and a send must not wait on it or fail
 * because of it.
 *
 * ── Deliberately not a message queue ────────────────────────────────────────
 *
 * In-process, not durable, and lost on restart. A dropped reply is not a lost message: the
 * original is safely in the database, and the runner's next cycle sees the conversation as unread
 * and replies then. That is the whole reason a real queue isn't warranted here — the durable path
 * already exists, and this is only the fast one.
 *
 * Kept to the one event it exists for. A general-purpose bus is how a codebase ends up with
 * control flow nobody can follow, so anything that can be a direct call should stay one.
 */
export const appEvents = new EventEmitter();

/**
 * A direct message was created and delivered.
 *
 * Payload: `{ conversation, senderId, receiverId, messageId }`.
 */
export const DM_SENT = "dm:sent";

/**
 * Announce without ever affecting the caller.
 *
 * `emit` is synchronous, so a listener that throws would throw *inside* whatever created the
 * message — turning a delivered message into a failed send. Guarded here rather than trusting
 * every future listener to be careful.
 */
export const announce = (event, payload) => {
  try {
    appEvents.emit(event, payload);
  } catch (error) {
    console.error(`appEvents ${event} listener error:`, error?.message ?? error);
  }
};
