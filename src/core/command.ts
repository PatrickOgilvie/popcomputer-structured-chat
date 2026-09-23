import { Effect, Schema } from "effect"

import { sha256Hex } from "./digest.js"

/** Opaque deterministic identity shared by command attempts in one chat turn. */
export const CommandIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^cmd_[0-9a-f]{64}$/)),
  Schema.brand("CommandId"),
)

/** Opaque deterministic identity shared by command attempts in one chat turn. */
export type CommandId = Schema.Schema.Type<typeof CommandIdSchema>

/** Inputs whose exact tuple identity defines one persisted command turn. */
export interface CommandIdentityInput {
  readonly namespace: string
  readonly chat: string
  readonly version: number
  readonly sessionId: string
  readonly expectedRevision: string | null
}

const CommandIdentity = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.Finite,
  Schema.String,
  Schema.NullOr(Schema.String),
])

/**
 * Derive the stable idempotency key for one persisted command turn.
 * The chosen command and its arguments belong in the application receipt,
 * so a retry cannot evade that receipt by selecting another command.
 */
export const deriveCommandId = Effect.fn(
  "popcomputer.structured_chat.command.derive_id",
)(function* (input: CommandIdentityInput): Effect.fn.Return<CommandId> {
  // These typed identity fields are already parsed by the owning session.
  const identity = yield* Schema.encodeEffect(
    Schema.fromJsonString(CommandIdentity),
  )([
    input.namespace,
    input.chat,
    input.version,
    input.sessionId,
    input.expectedRevision,
  ]).pipe(Effect.orDie)

  const digest = yield* sha256Hex(identity)

  return CommandIdSchema.make(`cmd_${digest}`)
})
