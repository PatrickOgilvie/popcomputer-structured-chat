import {
  makeChatTurnClient,
  makeChatDebugTurnClient,
  makeChatExplorationClient,
  type ChatTurnClient,
  type ChatDebugTurnClient,
  type ChatExplorationClient,
} from "@popcomputer/structured-chat/client"
import {
  Answer,
  Chat,
  Question,
  Stage,
  Tool,
  View,
} from "@popcomputer/structured-chat"
import * as Root from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"
import * as Debug from "@popcomputer/structured-chat/debug"
import * as CloudflareAI from "@popcomputer/structured-chat/model/cloudflare-workers-ai"
import * as OpenAI from "@popcomputer/structured-chat/model/openai-compatible"
import * as Live from "@popcomputer/structured-chat/live"
import * as OpenAILive from "@popcomputer/structured-chat/live/openai"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"
import {
  createStructuredChatUserAnswerStore,
  makeAssistantExplorationClient,
  makeAssistantChatModelAdapter,
  makeAssistantView,
  useStructuredChatUserAnswers,
  type AssistantChatModelAdapter,
  type AssistantExplorationClientResult,
  type StructuredChatUserAnswerStore,
  type StructuredChatUserAnswerUpdate,
} from "@popcomputer/structured-chat/assistant-ui"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "@popcomputer/structured-chat/assistant-ui/debug"
import {
  StructuredChatAssistantProvider,
  type StructuredChatAssistantProviderProps,
} from "@popcomputer/structured-chat/assistant-ui/react"
import { Effect, Layer, Schema } from "effect"
import { Socket } from "effect/unstable/socket"

const liveSpeech: Effect.Effect<Live.Presentation, Live.InvalidPresentation> =
  Live.say("Hello.")

const liveUrl: Effect.Effect<string, Live.ConnectionFailure> =
  OpenAILive.sidebandUrl("opaque-session")

void liveSpeech

void liveUrl

const liveConnection = OpenAILive.connection({
  sessionId: "opaque-session",
  socket: () => Layer.effect(Socket.Socket, Effect.never),
})

const persistedMessage: Root.Session.Message.ConversationMessage =
  Root.Session.Message.authored("Which topic?")

void liveConnection

void persistedMessage

void OpenAILive.createSession

const PackageView = View.define({
  name: "package_view",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})

const PackageVisibleAnswer = Answer.semantic(Schema.String, {
  description: "A package-visible answer.",
  ask: Question.fixed("What should the user see?"),
}).pipe(Answer.visibleToUser({ label: "Visible answer" }))

const PackageTool = Tool.define({
  name: "package_tool",
  description: "Exercise the built package declarations.",
  input: Schema.Struct({ value: Schema.String }),
  execute: ({ value }) => Effect.succeed({ value }),
}).pipe(Tool.present(PackageView, ({ value }) => ({ value })))

const PackageModelProfile = Root.Model.profile("package_profile")

const PackageProfiledStage = Root.Stage.tools({
  name: "package_profiled_stage",
  model: PackageModelProfile,
  instructions: ["Exercise the named package model profile."],
  tools: [PackageTool],
})

const packageProfileLayer: Layer.Layer<typeof PackageModelProfile> =
  OpenAI.layer(PackageModelProfile, {
    timeoutMilliseconds: 1_000,
    provider: OpenAI.Provider.cloudflareWorkersAI({
      model: "@cf/openai/package-profile",
      complete: () => Promise.resolve({}),
    }),
  })

const packageAdapter: AssistantChatModelAdapter = makeAssistantChatModelAdapter(
  { endpoint: "/chat" },
)

const packageExplorationClient = makeAssistantExplorationClient({
  endpoint: "/chat/explore",
})

const packageExplorationResult =
  (): Promise<AssistantExplorationClientResult> =>
    packageExplorationClient.run({
      session: { id: "package-session", revision: "1" },
      call: Tool.makeCall(PackageTool, { value: "related" }),
    })

const packageResponse: Chat.TurnResponse | undefined = undefined

const packagePersistedResponse: Chat.PersistedTurnResponse | undefined =
  undefined

const packageNonProgressingResponse: Chat.NonProgressingResponse | undefined =
  undefined

const packageAnswerSnapshot: Chat.UserAnswerSnapshot | undefined = undefined

const packageDebugSnapshot: Debug.Snapshot | undefined = undefined

const packageDebugTrace: Debug.Trace | undefined = undefined

const packageDebugStore = createStructuredChatDebugStore()

const packageAnswerStore: StructuredChatUserAnswerStore =
  createStructuredChatUserAnswerStore()

const packageAnswerUpdate: StructuredChatUserAnswerUpdate | undefined =
  undefined

const packageDebugAdapter: AssistantChatModelAdapter =
  makeAssistantChatModelAdapter({
    endpoint: "/chat/debug",
    onDebugTurn: packageDebugStore.receiveTurn,
  })

const packageAnswerAdapter: AssistantChatModelAdapter =
  makeAssistantChatModelAdapter({
    endpoint: "/chat",
    onAnswerSnapshot: packageAnswerStore.receive,
  })

const packageProviderProps: StructuredChatAssistantProviderProps = {
  chatKey: "package-chat",
  endpoint: "/chat",
  debug: true,
  debugEndpoint: "/chat/debug",
  children: null,
}

void PackageTool

void PackageModelProfile

void PackageProfiledStage

void PackageVisibleAnswer

void inMemoryChatSessionStore

void Scenario.call(PackageTool, { value: "typed" })

void makeAssistantView(PackageView, { render: () => null })

void packageAdapter

void packageExplorationResult

void packageDebugAdapter

void packageAnswerAdapter

void packageAnswerStore

void packageDebugStore

/** Compile-only fixtures prove the published protocol type names remain reachable. */
export const protocolFixtures = {
  packageAnswerUpdate,
  packageDebugSnapshot,
  packageDebugTrace,
  packageResponse,
  packagePersistedResponse,
  packageNonProgressingResponse,
  packageAnswerSnapshot,
}

void Answer.visibleToUser

void Chat.InvalidUserAnswerProjection

void Chat.UserAnswerSnapshotSchema

void Debug.present

void Debug.presentState

void Debug.turn

void CloudflareAI.classifyError

void OpenAI.layer

void StructuredChatDebugPanel

void StructuredChatAssistantProvider

void packageProviderProps

void packageProfileLayer

void useStructuredChatUserAnswers

// @ts-expect-error flat constructors are intentionally absent from the root
void Root.defineChat

const plainClient: ChatTurnClient = makeChatTurnClient({ endpoint: "/chat" })

const debugClient: ChatDebugTurnClient = makeChatDebugTurnClient({
  endpoint: "/debug",
})

const explorationClient: ChatExplorationClient = makeChatExplorationClient({
  endpoint: "/explore",
})

const expired: Root.Session.Expired = new Root.Session.Expired({
  reason: "expired",
})

void plainClient

void debugClient

void explorationClient

void expired

const PackageMessage = Root.Message.define({
  name: "package_message",
  input: Schema.String,
  text: (text) => text,
})

const PackageComposedChat = Chat.define({
  name: "package_composed",
  version: 1,
  messages: [PackageMessage],
  stages: [PackageProfiledStage],
})

void Chat.start(PackageComposedChat, { sessionId: "package", input: null })

void Chat.post(PackageComposedChat, {
  sessionId: "package",
  expectedRevision: "1",
  messageId: "one",
  message: PackageMessage,
  input: "Hello",
})

const typeSafeJudgment: Effect.Effect<
  "billing" | "support",
  TypeSafe.EvaluationError,
  TypeSafe.Service
> = Effect.gen(function* () {
  const service = yield* TypeSafe.Service
  const result = yield* service.evaluate({
    state: "Please send my invoice",
    questions: TypeSafe.batch({
      team: TypeSafe.choice("Choose the responsible team", {
        billing: "Invoices and payments",
        support: "Help using the product",
      }),
    }),
  })
  return result.answers.team.value
})
void typeSafeJudgment

const detectedFields = {
  team: Answer.explicit(Schema.Literals(["billing", "support"]), {
    description: "The owning team",
    ask: Question.fixed("Which team?"),
  }),
}
const detectedStage = Stage.collect({
  name: "package_detection",
  fields: detectedFields,
  detector: TypeSafe.detection(detectedFields, {
    acceptance: { team: { minimumProbability: 0.9 } },
  }),
})
void detectedStage
