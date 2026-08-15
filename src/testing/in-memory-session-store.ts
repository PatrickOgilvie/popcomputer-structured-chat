import { Effect, Layer, Ref } from "effect"
import {
  ChatSessionConflict,
  ChatSessionStore,
  type ChatSessionScope,
  type ChatSessionSnapshot,
  type ReplaceChatSessionInput,
} from "../core/session.js"

const scopeKey = (scope: ChatSessionScope): string =>
  JSON.stringify([
    scope.chat,
    scope.version,
    scope.namespace,
    scope.sessionId,
  ])

const nextRevision = (current: ChatSessionSnapshot | undefined): string =>
  current === undefined
    ? "1"
    : String(Number.parseInt(current.revision, 10) + 1)

const replaceSnapshot = (
  sessions: ReadonlyMap<string, ChatSessionSnapshot>,
  input: ReplaceChatSessionInput,
): readonly [
  ChatSessionSnapshot | ChatSessionConflict,
  ReadonlyMap<string, ChatSessionSnapshot>,
] => {
  const key = scopeKey(input)
  const current = sessions.get(key)
  if (
    (current === undefined && input.expectedRevision !== null) ||
    (current !== undefined &&
      input.expectedRevision !== current.revision)
  ) {
    return [
      new ChatSessionConflict({ reason: "concurrent_update" }),
      sessions,
    ]
  }

  const snapshot: ChatSessionSnapshot = {
    revision: nextRevision(current),
    state: input.state,
    messages: input.messages,
  }
  const next = new Map(sessions)
  next.set(key, snapshot)

  return [snapshot, next]
}

/** In-memory optimistic session store intended for tests and examples. */
export const inMemoryChatSessionStore: Layer.Layer<ChatSessionStore> =
  Layer.effect(
    ChatSessionStore,
    Ref.make<ReadonlyMap<string, ChatSessionSnapshot>>(new Map()).pipe(
      Effect.map((sessions) => ({
        load: (scope: ChatSessionScope) =>
          Ref.get(sessions).pipe(
            Effect.map((current) => current.get(scopeKey(scope)) ?? null),
          ),
        replace: (input: ReplaceChatSessionInput) =>
          Ref.modify(sessions, (current) =>
            replaceSnapshot(current, input),
          ).pipe(
            Effect.flatMap((result) =>
              result instanceof ChatSessionConflict
                ? Effect.fail(result)
                : Effect.succeed({ revision: result.revision }),
            ),
          ),
      })),
    ),
  )
