import type { Effect, Schema } from "effect"
import type { Definition } from "../Chat.js"
import type {
  ChatError,
  ChatRequirements,
  ChatStageTuple,
  ChatState,
  ChatTurn,
} from "../core/chat.js"
import type { UntrustedMessage } from "../core/model.js"
import { read } from "../internal/chat/definition.js"

/** Read the valid initial state for an opaque chat definition. */
export const initialState = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
): ChatState<Name, Version, Stages> => read(chat).initialState

/** Strictly decode persisted state for an opaque chat definition. */
export const parseState = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this specialist boundary verifies malformed persisted state through the definition-owned parser
  input: unknown,
): Effect.Effect<ChatState<Name, Version, Stages>, Schema.SchemaError> =>
  read(chat).parseState(input)

/** Run a checked, non-persisted chat transition in tests. */
export const run = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  input: {
    readonly state: ChatState<Name, Version, Stages>
    readonly messages: ReadonlyArray<UntrustedMessage>
  },
): Effect.Effect<
  ChatTurn<Name, Version, Stages>,
  ChatError<Stages>,
  ChatRequirements<Stages>
> => read(chat).run(input)
