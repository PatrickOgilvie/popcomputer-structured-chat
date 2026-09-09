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
  Tool,
  View,
} from "@popcomputer/structured-chat"
import * as Root from "@popcomputer/structured-chat"
import * as Debug from "@popcomputer/structured-chat/debug"
import * as CloudflareAI from "@popcomputer/structured-chat/model/cloudflare-workers-ai"
import * as OpenAI from "@popcomputer/structured-chat/model/openai-compatible"
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

const packageAdapter: AssistantChatModelAdapter =
  makeAssistantChatModelAdapter({ endpoint: "/chat" })
const packageExplorationClient = makeAssistantExplorationClient({
  endpoint: "/chat/explore",
})
const packageExplorationResult: Promise<AssistantExplorationClientResult> =
  packageExplorationClient.run({
    session: { id: "package-session", revision: "1" },
    call: Tool.makeCall(PackageTool, { value: "related" }),
  })
const packageResponse: Chat.TurnResponse | undefined = undefined
const packagePersistedResponse: Chat.PersistedTurnResponse | undefined =
  undefined
const packageNonProgressingResponse:
  | Chat.NonProgressingResponse
  | undefined = undefined
const packageAnswerSnapshot: Chat.UserAnswerSnapshot | undefined =
  undefined
const packageDebugSnapshot: Debug.Snapshot | undefined =
  undefined
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
void packageAnswerUpdate
void packageDebugSnapshot
void packageDebugTrace
void packageDebugStore
void packageResponse
void packagePersistedResponse
void packageNonProgressingResponse
void packageAnswerSnapshot
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
const debugClient: ChatDebugTurnClient = makeChatDebugTurnClient({ endpoint: "/debug" })
const explorationClient: ChatExplorationClient = makeChatExplorationClient({ endpoint: "/explore" })
const expired: Root.Session.Expired = new Root.Session.Expired({ reason: "expired" })
void plainClient
void debugClient
void explorationClient
void expired


const PackageMessage = Root.Message.define({ name: "package_message", input: Schema.String, text: (text) => text })
const PackageComposedChat = Chat.define({ name: "package_composed", version: 1, messages: [PackageMessage], stages: [PackageProfiledStage] })
void Chat.start(PackageComposedChat, { sessionId: "package", input: null })
void Chat.post(PackageComposedChat, { sessionId: "package", expectedRevision: "1", messageId: "one", message: PackageMessage, input: "Hello" })
