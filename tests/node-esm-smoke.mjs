import {
  ChatSessionStore,
  defineTool,
  defineView,
  Message,
  Stage,
  Tool,
} from "@popcomputer/structured-chat"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"
import {
  makeAssistantChatModelAdapter,
  makeAssistantView,
} from "@popcomputer/structured-chat/assistant-ui"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "@popcomputer/structured-chat/assistant-ui/debug"
import { Effect, Schema } from "effect"

const ResultView = defineView({
  name: "result",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})

const tool = defineTool({
  name: "echo",
  description: "Echo one value.",
  input: Schema.Struct({ value: Schema.String }),
  execute: ({ value }) => Effect.succeed({ value }),
}).pipe(Tool.present(ResultView, ({ value }) => ({ value })))

const result = await Effect.runPromise(tool.execute({ value: "ok" }))

if (result.views[0]?.data.value !== "ok") {
  throw new Error("Root entry point smoke test failed")
}

const EchoStage = Stage.tools({
  name: "echo_stage",
  instructions: ["Echo one value."],
  tools: [tool],
})
const planned = await Effect.runPromise(
  EchoStage.plan([Message.user("Echo a scripted value.")]).pipe(
    Effect.provide(
      Scenario.model(Scenario.call(tool, { value: "scripted" })),
    ),
  ),
)

if (planned.arguments.value !== "scripted") {
  throw new Error("Testing scenario smoke test failed")
}

const stored = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* ChatSessionStore
    yield* store.replace({
      namespace: "node-smoke",
      sessionId: "session-1",
      chat: "node_smoke",
      version: 1,
      expectedRevision: null,
      state: { status: "ready" },
      messages: [],
    })
    return yield* store.load({
      namespace: "node-smoke",
      sessionId: "session-1",
      chat: "node_smoke",
      version: 1,
    })
  }).pipe(Effect.provide(inMemoryChatSessionStore)),
)

if (stored?.revision !== "1") {
  throw new Error("Testing session store smoke test failed")
}

const ResultUI = makeAssistantView(ResultView, {
  render: () => null,
})

if (ResultUI.unstable_data.name !== "result") {
  throw new Error("Assistant view smoke test failed")
}

const debugStore = createStructuredChatDebugStore()
void StructuredChatDebugPanel
if (debugStore.getSnapshot() !== null) {
  throw new Error("Assistant debug inspector smoke test failed")
}

let requestedEndpoint
const adapter = makeAssistantChatModelAdapter({
  endpoint: "https://example.invalid/turn",
  fetch: (input) => {
    requestedEndpoint = input
    return Promise.resolve(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          session: { id: "node-smoke", revision: "1" },
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Adapter ready" }],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )
  },
})
const adapted = await adapter.run({
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Run the adapter smoke test." }],
      metadata: { custom: {} },
    },
  ],
  abortSignal: new AbortController().signal,
})

if (
  requestedEndpoint !== "https://example.invalid/turn" ||
  adapted.content[0]?.type !== "text" ||
  adapted.content[0].text !== "Adapter ready"
) {
  throw new Error("Assistant chat adapter smoke test failed")
}
