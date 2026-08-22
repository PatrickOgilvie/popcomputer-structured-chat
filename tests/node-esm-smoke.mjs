import { Model, Session, Stage, Tool, View } from "@popcomputer/structured-chat"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"
import {
  makeAssistantExplorationClient,
  makeAssistantChatModelAdapter,
  makeAssistantView,
} from "@popcomputer/structured-chat/assistant-ui"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "@popcomputer/structured-chat/assistant-ui/debug"
import {
  cleanupExpiredD1ChatSessions,
  makeD1ChatSessionStore,
} from "@popcomputer/structured-chat/d1"
import { Effect, Result, Schema } from "effect"

const ResultView = View.define({
  name: "result",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})

const tool = Tool.define({
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
  EchoStage.plan([Model.Message.user("Echo a scripted value.")]).pipe(
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
    const store = yield* Session.Store
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

if (!makeD1ChatSessionStore || !cleanupExpiredD1ChatSessions) {
  throw new Error("./d1 entry point smoke test failed")
}

// node:sqlite is available unflagged from Node 23.4; exercise the built D1
// adapter against a real SQL engine when the runtime provides it.
try {
  const { DatabaseSync } = await import("node:sqlite")
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(`
    CREATE TABLE structured_chat_sessions (
      namespace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat TEXT NOT NULL,
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      state TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, session_id, chat, version)
    )
  `)
  const d1Store = makeD1ChatSessionStore({
    prepare: (query) => {
      const statement = sqlite.prepare(query)
      let values = []
      const bind = (...next) => {
        values = next
        return { bind, first: async () => statement.get(...values) ?? null, run: async () => ({ meta: { changes: statement.run(...values).changes } }) }
      }
      return bind()
    },
  })
  const d1Stored = await Effect.runPromise(
    Effect.gen(function* () {
      yield* d1Store.replace({
        namespace: "node-smoke",
        sessionId: "session-1",
        chat: "node_smoke",
        version: 1,
        expectedRevision: null,
        state: { status: "ready" },
        messages: [],
      })
      return yield* d1Store.load({
        namespace: "node-smoke",
        sessionId: "session-1",
        chat: "node_smoke",
        version: 1,
      })
    }),
  )
  if (d1Stored?.revision !== "1") {
    throw new Error("./d1 entry point smoke test failed")
  }
  const removed = await Effect.runPromise(
    cleanupExpiredD1ChatSessions(
      {
        prepare: (query) => {
          const statement = sqlite.prepare(query)
          let values = []
          const bind = (...next) => {
            values = next
            return { bind, first: async () => statement.get(...values) ?? null, run: async () => ({ meta: { changes: statement.run(...values).changes } }) }
          }
          return bind()
        },
      },
      { expiringNamespacePrefixes: ["other:"], retentionMillis: 60_000 },
    ),
  )
  if (removed !== 0) {
    throw new Error("./d1 entry point smoke test failed")
  }
} catch (error) {
  if (
    error?.code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    String(error).includes("node:sqlite")
  ) {
    // Runtime without a usable node:sqlite; the type checks above still ran.
  } else {
    throw error
  }
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

let requestedExploration
const explorationClient = makeAssistantExplorationClient({
  endpoint: "https://example.invalid/explore",
  fetch: (_input, init) => {
    requestedExploration = JSON.parse(String(init.body))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          content: [{ type: "text", text: "Exploration ready" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )
  },
})
const explored = await explorationClient.run({
  session: { id: "node-smoke", revision: "9" },
  call: { name: "echo", arguments: { value: "related" } },
})

if (
  requestedExploration.session.revision !== undefined ||
  requestedExploration.session.id !== "node-smoke" ||
  !Result.isSuccess(explored) ||
  explored.success.content[0]?.type !== "text"
) {
  throw new Error("Assistant exploration client smoke test failed")
}
