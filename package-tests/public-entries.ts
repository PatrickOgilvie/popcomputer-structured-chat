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
import { Effect, Schema } from "effect"

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

void PackageTool
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
void useStructuredChatUserAnswers

// @ts-expect-error flat constructors are intentionally absent from the root
void Root.defineChat
