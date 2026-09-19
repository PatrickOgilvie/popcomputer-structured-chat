import { Effect, Exit, Layer } from "effect"
import { Session } from "@popcomputer/structured-chat"
import { makeSqlChatSessionStore } from "@popcomputer/structured-chat/sqlite"
import { layer, makeSqliteChatSessionStore, cleanupExpiredSqliteChatSessions } from "@popcomputer/structured-chat/effect-sqlite"

// This Node entry smoke test installs no SQLite driver and opens no connection.
if (!Layer.isLayer(layer()) || !Effect.isEffect(makeSqliteChatSessionStore()) ||
    !Effect.isEffect(cleanupExpiredSqliteChatSessions({ expiringNamespacePrefixes: [], retentionMillis: 1000 }))) {
  throw new Error("Missing Effect SQLite package exports")
}
const scope = { namespace: "node", sessionId: "sqlite", chat: "sqlite_smoke", version: 1 }
const store = makeSqlChatSessionStore({ read: () => Effect.succeed(null), write: () => Effect.succeed(0) })
if (await Effect.runPromise(store.load(scope)) !== null) throw new Error("Unexpected SQLite load result")
const result = await Effect.runPromiseExit(store.replace({ ...scope, expectedRevision: null, state: {}, messages: [Session.Message.submitted("hello")] }))
if (!Exit.isFailure(result)) throw new Error("Zero affected rows must not commit a session")
