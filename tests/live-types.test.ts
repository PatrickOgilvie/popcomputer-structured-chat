import { Context, Effect, Layer, Option, Schema } from "effect"
import { Socket } from "effect/unstable/socket"
import type { Model, Session } from "../src/index.js"
import { Chat, Stage, Tool } from "../src/index.js"
import * as Live from "../src/integrations/live.js"
import * as OpenAI from "../src/integrations/openai-live.js"

class SocketHost extends Context.Service<
  SocketHost,
  {
    readonly connect: (
      url: string,
    ) => Effect.Effect<Socket.Socket, SocketHostFailure>
  }
>()("LiveTypes/SocketHost") {}

class SocketHostFailure extends Schema.TaggedError<SocketHostFailure>()(
  "SocketHostFailure",
  {},
) {}

const connection = OpenAI.connection({
  sessionId: "provider",
  socket: (url) =>
    Layer.effect(
      Socket.Socket,
      SocketHost.pipe(Effect.flatMap((host) => host.connect(url))),
    ),
})

class Catalogue extends Context.Service<
  Catalogue,
  { readonly lookup: Effect.Effect<string> }
>()("LiveTypes/Catalogue") {}

class Policy extends Context.Service<Policy, { readonly ready: boolean }>()(
  "LiveTypes/Policy",
) {}

class LookupFailure extends Schema.TaggedError<LookupFailure>()(
  "LookupFailure",
  {},
) {}

class PolicyFailure extends Schema.TaggedError<PolicyFailure>()(
  "PolicyFailure",
  {},
) {}

const Find = Tool.define({
  name: "find",
  description: "Find",
  input: Schema.Struct({}),
  execute: (): Effect.Effect<string, LookupFailure, Catalogue> =>
    Catalogue.pipe(Effect.flatMap(({ lookup }) => lookup)),
})

const Workflow = Chat.define({
  name: "typed_live",
  version: 1,
  stages: [
    Stage.tools({ name: "find", instructions: ["Find"], tools: [Find] }),
  ],
})

const action = Live.turn(Workflow).pipe(
  Effect.flatMap((reply) => Live.present(reply, { speech: "Found." })),
)

const resolve = Effect.gen(function* () {
  const context = yield* Live.context
  const policy = yield* Policy

  if (!policy.ready) return yield* new PolicyFailure({})

  return Option.isSome(context.candidate)
    ? Live.ready(context.candidate.value)
    : Live.awaitContext
})

const run = Live.run(
  {
    liveSessionId: "provider",
    namespace: "tenant",
    sessionId: "session",
    chat: Workflow.name,
    version: 1,
  },
  { resolve, action },
)

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type Assert<T extends true> = T

export type SocketRequirementsAreInferred = Assert<
  Equal<Layer.Services<typeof connection>, SocketHost | OpenAI.TextTokens>
>

export type SocketFailuresArePreserved = Assert<
  Equal<
    Layer.Error<typeof connection>,
    SocketHostFailure | Live.ConnectionFailure
  >
>

export type ModelTextHasNoConversationAuthority = Assert<
  Equal<
    Model.UntrustedMessage extends Session.Message.ConversationMessage
      ? true
      : false,
    false
  >
>

export type AuthoredMessagesCannotBeUserSpeech = Assert<
  Equal<
    Extract<
      Session.Message.ConversationMessage,
      { readonly _tag: "Authored" }
    >["role"],
    "assistant"
  >
>

export type ObservationsRequireReplayIdentity = Assert<
  Equal<
    Extract<
      Session.Message.ConversationMessage,
      { readonly _tag: "Observed" }
    >["batchId"],
    string
  >
>

export type ExactRequirements = Assert<
  Equal<
    Effect.Services<typeof run>,
    | Catalogue
    | Policy
    | Model.Service
    | Session.Store
    | Live.Journal
    | Live.Connection
    | Live.Publisher
  >
>

export type PreservesApplicationErrors = Assert<
  Equal<
    Extract<Effect.Error<typeof run>, LookupFailure | PolicyFailure>,
    LookupFailure | PolicyFailure
  >
>

export type PreservesAdmissionFailure = Assert<
  Equal<
    Extract<Effect.Error<typeof run>, Chat.TurnControlUnavailable>,
    Chat.TurnControlUnavailable
  >
>

export type PublicOutcome = Assert<
  Equal<Effect.Success<typeof run>, Live.Summary>
>

export type OrdinaryTurnUnchanged = Assert<
  Equal<
    Extract<
      Chat.TurnError<typeof Workflow>,
      Chat.TurnSuperseded | Chat.TurnControlUnavailable
    >,
    never
  >
>

const controlled = Chat.advance(Workflow, {
  sessionId: "session",
  turn: { _tag: "Submitted", message: "Find" },
})

export type ControlledAuthorityIsRequired = Assert<
  Equal<
    Effect.Services<typeof controlled>,
    Catalogue | Model.Service | Session.Store | Chat.TurnControl
  >
>
