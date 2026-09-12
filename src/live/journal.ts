import { Predicate, Context, Effect, Layer, Option, Schema } from "effect"
import {
  ChatSessionReplacementSchema,
  ChatSessionRevisionSchema,
  ChatSessionStore,
  type ChatSessionScope,
} from "../core/session.js"
import { Binding, Id, RecoveryRequired } from "./contracts.js"

import { State } from "./state.js"

/** Journal storage was unavailable, malformed, or concurrently replaced. */
export class JournalFailure extends Schema.TaggedError<JournalFailure>()(
  "LiveJournalFailure",
  {
    reason: Schema.Literals([
      "read_failed",
      "write_failed",
      "conflict",
      "invalid_snapshot",
    ]),
  },
) {}

/** Durable journal snapshot, including its opaque storage revision. */
export interface Snapshot {
  readonly revision: string
  readonly state: State
}

/** Atomic persistence capability consumed by the Live session owner. */
export class Journal extends Context.Service<
  Journal,
  {
    readonly own: <A, E, R>(
      binding: Binding,
      program: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | JournalFailure | RecoveryRequired, R>
    readonly load: (
      binding: Binding,
    ) => Effect.Effect<Option.Option<Snapshot>, JournalFailure>
    readonly replace: (
      binding: Binding,
      revision: Option.Option<string>,
      state: State,
    ) => Effect.Effect<string, JournalFailure>
  }
>()("@popcomputer/structured-chat/live/Journal") {}

/** @internal Deterministic tuple identity, shared by journal keys and observation identities. */
export const identity = (binding: Binding): Effect.Effect<string> =>
  Effect.promise(async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        binding.namespace,
        binding.sessionId,
        binding.chat,
        binding.version,
        binding.liveSessionId,
      ]),
    )

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

    return `live_${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  })

const Owner = Schema.Struct({
  liveSessionId: Id,
  status: Schema.Literals(["Owned", "Released"]),
})

/**
 * Back Live journals with the existing atomic session store. Supply a dedicated
 * namespace; the layer captures its store so it can differ from workflow storage.
 */
export const journal = (options: {
  readonly namespace: string
}): Layer.Layer<Journal, Schema.SchemaError, ChatSessionStore> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const namespace = yield* Schema.decodeEffect(Binding.fields.namespace)(
        options.namespace,
      )

      const store = yield* ChatSessionStore

      const scope = (binding: Binding): Effect.Effect<ChatSessionScope> =>
        identity(binding).pipe(
          Effect.map((sessionId) => ({
            namespace,
            sessionId,
            chat: "live_journal",
            version: 1,
          })),
        )

      return Journal.of({
        own: <A, E, R>(binding: Binding, program: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            // The owner key excludes the provider session: two Live connections
            // cannot independently mutate the same workflow session.
            const sessionId = yield* identity({
              ...binding,
              liveSessionId: "workflow-owner",
            })

            const key = { namespace, sessionId, chat: "live_owner", version: 1 }

            const raw = yield* store
              .load(key)
              .pipe(
                Effect.mapError(
                  () => new JournalFailure({ reason: "read_failed" }),
                ),
              )

            const previous =
              raw === null
                ? null
                : yield* Schema.decodeUnknownEffect(
                    Schema.Struct({
                      revision: ChatSessionRevisionSchema,
                      state: Owner,
                      messages: Schema.Array(Schema.Never),
                    }),
                  )(raw, { onExcessProperty: "error" }).pipe(
                    Effect.mapError(
                      () => new JournalFailure({ reason: "invalid_snapshot" }),
                    ),
                  )

            if (previous?.state.status === "Owned")
              return yield* new RecoveryRequired({
                reason: "session_already_owned",
              })

            const claimed = yield* store
              .replace({
                ...key,
                expectedRevision: previous?.revision ?? null,
                state: {
                  status: "Owned",
                  liveSessionId: binding.liveSessionId,
                },
                messages: [],
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new JournalFailure({
                      reason: Predicate.isTagged(error, "ChatSessionConflict")
                        ? "conflict"
                        : "write_failed",
                    }),
                ),
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(ChatSessionReplacementSchema)(
                    value,
                  ).pipe(
                    Effect.mapError(
                      () => new JournalFailure({ reason: "invalid_snapshot" }),
                    ),
                  ),
                ),
              )

            // Failure deliberately retains ownership. A failed process is not proof
            // that its commands stopped; there is no timer-based ownership takeover.
            const result = yield* program
            yield* store
              .replace({
                ...key,
                expectedRevision: claimed.revision,
                state: {
                  status: "Released",
                  liveSessionId: binding.liveSessionId,
                },
                messages: [],
              })
              .pipe(
                Effect.mapError(
                  () => new JournalFailure({ reason: "write_failed" }),
                ),
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(ChatSessionReplacementSchema)(
                    value,
                    { onExcessProperty: "error" },
                  ).pipe(
                    Effect.mapError(
                      () => new JournalFailure({ reason: "invalid_snapshot" }),
                    ),
                  ),
                ),
              )

            return result
          }),
        load: Effect.fn("LiveJournal.load")(function* (binding) {
          const key = yield* scope(binding)

          const raw = yield* store
            .load(key)
            .pipe(
              Effect.mapError(
                () => new JournalFailure({ reason: "read_failed" }),
              ),
            )

          if (raw === null) return Option.none()

          const parsed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              revision: ChatSessionRevisionSchema,
              state: State,
              messages: Schema.Array(Schema.Never),
            }),
          )(raw, { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              () => new JournalFailure({ reason: "invalid_snapshot" }),
            ),
          )

          if (
            (yield* identity(parsed.state.binding)) !==
            (yield* identity(binding))
          )
            return yield* new JournalFailure({ reason: "invalid_snapshot" })

          return Option.some({ revision: parsed.revision, state: parsed.state })
        }),
        replace: Effect.fn("LiveJournal.replace")(
          function* (binding, revision, state) {
            const parsed = yield* Schema.decodeEffect(State)(state, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new JournalFailure({ reason: "invalid_snapshot" }),
              ),
            )

            if (
              (yield* identity(parsed.binding)) !== (yield* identity(binding))
            )
              return yield* new JournalFailure({ reason: "invalid_snapshot" })
            const key = yield* scope(binding)

            const raw = yield* store
              .replace({
                ...key,
                expectedRevision: Option.getOrNull(revision),
                state: parsed,
                messages: [],
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new JournalFailure({
                      reason: Predicate.isTagged(error, "ChatSessionConflict")
                        ? "conflict"
                        : "write_failed",
                    }),
                ),
              )

            const result = yield* Schema.decodeUnknownEffect(
              ChatSessionReplacementSchema,
            )(raw, { onExcessProperty: "error" }).pipe(
              Effect.mapError(
                () => new JournalFailure({ reason: "invalid_snapshot" }),
              ),
            )

            return result.revision
          },
        ),
      })
    }),
  )
