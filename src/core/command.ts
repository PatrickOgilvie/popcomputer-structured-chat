import { Effect, Schema } from "effect"

/** Opaque deterministic identity supplied to one command execution. */
export const CommandIdSchema = Schema.String.pipe(
  Schema.pattern(/^cmd_[0-9a-f]{64}$/),
  Schema.brand("CommandId"),
)

/** Opaque deterministic identity supplied to one command execution. */
export type CommandId = Schema.Schema.Type<typeof CommandIdSchema>

/** Inputs whose exact tuple identity defines one command attempt. */
export interface CommandIdentityInput {
  readonly namespace: string
  readonly chat: string
  readonly version: number
  readonly sessionId: string
  readonly expectedRevision: string | null
  readonly command: string
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Derive the stable idempotency key for one persisted command turn. */
export const deriveCommandId = (
  input: CommandIdentityInput,
): Effect.Effect<CommandId> =>
  Effect.promise(async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify([
        input.namespace,
        input.chat,
        input.version,
        input.sessionId,
        input.expectedRevision,
        input.command,
      ]),
    )
    const digest = await crypto.subtle.digest("SHA-256", encoded)
    return Schema.decodeSync(CommandIdSchema)(
      `cmd_${toHex(new Uint8Array(digest))}`,
    )
  })
