import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// A real consumer installation with Effect as its only installed dependency.
const fixture = mkdtempSync(join(tmpdir(), "structured-chat-client-"))

const project = fileURLToPath(new URL("..", import.meta.url))

try {
  cpSync(join(project, "dist"), join(fixture, "dist"), { recursive: true })
  cpSync(join(project, "package.json"), join(fixture, "package.json"))
  mkdirSync(join(fixture, "node_modules"))
  symlinkSync(
    join(project, "node_modules", "effect"),
    join(fixture, "node_modules", "effect"),
    "dir",
  )
  writeFileSync(
    join(fixture, "consumer.mjs"),
    `
import assert from "node:assert/strict"
import { Effect, Result } from "effect"
import { makeChatTurnClient, makeChatDebugTurnClient, makeChatExplorationClient } from "@popcomputer/structured-chat/client"
import * as Live from "@popcomputer/structured-chat/live"
import * as OpenAILive from "@popcomputer/structured-chat/live/openai"
await assert.rejects(import("react"), { code: "ERR_MODULE_NOT_FOUND" })
await assert.rejects(import("@assistant-ui/react"), { code: "ERR_MODULE_NOT_FOUND" })
await assert.rejects(import("openai"), { code: "ERR_MODULE_NOT_FOUND" })
assert.equal((await Effect.runPromise(Live.say("Hello."))).speech, "Hello.")
assert.equal(await Effect.runPromise(OpenAILive.sidebandUrl("opaque")), "wss://api.openai.com/v1/live/sessions/opaque/attach")
const notice = { schemaVersion: 2, message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }
const turn = makeChatTurnClient({ endpoint: "/chat", fetch: async () => Response.json(notice) })
assert.deepEqual(await turn.run({ message: "Hello" }), Result.succeed(notice))
const failure = { schemaVersion: 2, outcome: "failure", session: null, trace: { schemaVersion: 1, events: [] } }
const debug = makeChatDebugTurnClient({ endpoint: "/debug", fetch: async () => Response.json(failure, { status: 503 }) })
assert.deepEqual(await debug.run({ message: "Hello" }), Result.succeed(failure))
const exploration = { schemaVersion: 1, content: [{ type: "text", text: "Found" }] }
const explore = makeChatExplorationClient({ endpoint: "/explore", fetch: async () => Response.json(exploration) })
assert.deepEqual(await explore.run({ session: { id: "session:1" }, call: { name: "inspect", arguments: {} } }), Result.succeed(exploration))
`,
  )
  execFileSync(process.execPath, [join(fixture, "consumer.mjs")], {
    cwd: fixture,
    stdio: "inherit",
  })
  process.stdout.write(
    "Client and Live ESM smoke passed without React, assistant-ui, or OpenAI SDK installed.\n",
  )
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
