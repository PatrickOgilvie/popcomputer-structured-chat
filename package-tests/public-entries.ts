import {
  defineTool,
  defineView,
  Tool,
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

void PackageTool
void inMemoryChatSessionStore
void Scenario.call(PackageTool, { value: "typed" })
void makeAssistantView(PackageView, { render: () => null })
void packageAdapter
void packageResponse
