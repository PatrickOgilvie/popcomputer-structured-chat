import {
  defineTool,
  defineView,
  presentChatDebugReply,
  Tool,
  type StructuredChatDebugSnapshot,
  type StructuredChatTurnResponse,
} from "@popcomputer/structured-chat"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"
import {
  makeAssistantChatModelAdapter,
  makeAssistantView,
  type AssistantChatModelAdapter,
} from "@popcomputer/structured-chat/assistant-ui"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "@popcomputer/structured-chat/assistant-ui/debug"
import { Effect, Schema } from "effect"

const PackageView = defineView({
  name: "package_view",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})

const PackageTool = defineTool({
  name: "package_tool",
  description: "Exercise the built package declarations.",
  input: Schema.Struct({ value: Schema.String }),
  execute: ({ value }) => Effect.succeed({ value }),
}).pipe(Tool.present(PackageView, ({ value }) => ({ value })))

const packageAdapter: AssistantChatModelAdapter =
  makeAssistantChatModelAdapter({ endpoint: "/chat" })
const packageResponse: StructuredChatTurnResponse | undefined = undefined
const packageDebugSnapshot: StructuredChatDebugSnapshot | undefined =
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
void packageDebugAdapter
void packageDebugSnapshot
void packageDebugStore
void packageResponse
void presentChatDebugReply
void StructuredChatDebugPanel
