import { Chat, Tool, View } from "@popcomputer/structured-chat"
import * as Root from "@popcomputer/structured-chat"
import * as Debug from "@popcomputer/structured-chat/debug"
import * as CloudflareAI from "@popcomputer/structured-chat/model/cloudflare-workers-ai"
import * as OpenAI from "@popcomputer/structured-chat/model/openai-compatible"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"
import {
  makeAssistantExplorationClient,
  makeAssistantChatModelAdapter,
  makeAssistantView,
  type AssistantChatModelAdapter,
  type AssistantExplorationClientResult,
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
const packageDebugSnapshot: Debug.Snapshot | undefined =
  undefined
const packageDebugStore = createStructuredChatDebugStore()
const packageDebugAdapter: AssistantChatModelAdapter =
  makeAssistantChatModelAdapter({
    endpoint: "/chat/debug",
    onDebugSnapshot: packageDebugStore.receive,
  })

void PackageTool
void inMemoryChatSessionStore
void Scenario.call(PackageTool, { value: "typed" })
void makeAssistantView(PackageView, { render: () => null })
void packageAdapter
void packageExplorationResult
void packageDebugAdapter
void packageDebugSnapshot
void packageDebugStore
void packageResponse
void Debug.present
void CloudflareAI.classifyError
void OpenAI.layer
void StructuredChatDebugPanel

// @ts-expect-error flat constructors are intentionally absent from the root
void Root.defineChat
