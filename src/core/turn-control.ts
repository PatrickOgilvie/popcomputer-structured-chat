import { Context, Effect, Schema } from "effect"
import type { CommandId } from "./command.js"

/** A newer intent superseded work before command admission or query commit. */
export class TurnSuperseded extends Schema.TaggedError<TurnSuperseded>()(
  "TurnSuperseded",
  { reason: Schema.Literals(["newer_intent", "session_closing"]) },
) {}

/** The execution owner could not durably authorize this turn. */
export class TurnControlUnavailable extends Schema.TaggedError<TurnControlUnavailable>()(
  "TurnControlUnavailable",
  {
    reason: Schema.Literals(["admission_failed", "commit_checkpoint_failed"]),
  },
) {}

/** Expected refusal or failure of the execution authority. */
export type TurnControlFailure = TurnSuperseded | TurnControlUnavailable

/**
 * Cooperative execution control supplied by one session owner. Admission must
 * be atomic relative to supersession. Once admitted, beforeCommit must allow
 * the actual command outcome to be persisted even if a newer intent arrives.
 */
export interface TurnControlService {
  readonly check: () => Effect.Effect<void, TurnControlFailure>
  readonly admitCommand: (
    commandId: CommandId,
  ) => Effect.Effect<void, TurnControlFailure>
  readonly beforeCommit: () => Effect.Effect<void, TurnControlFailure>
}

/** Execution authority required by controlled chat turns. */
export class TurnControl extends Context.Service<
  TurnControl,
  TurnControlService
>()("@popcomputer/structured-chat/TurnControl") {}

/** @internal Ordinary submitted turns have no external intent owner. */
export const uncontrolledTurn: TurnControlService = {
  check: () => Effect.void,
  admitCommand: () => Effect.void,
  beforeCommit: () => Effect.void,
}
