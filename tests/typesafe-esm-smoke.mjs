import { registerHooks } from "node:module"
import { Effect, Redacted } from "effect"

const guard = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@typesafe-ai/sdk")
      throw new Error("Optional SDK is unavailable")
    return nextResolve(specifier, context)
  },
})
try {
  const core = await import("@popcomputer/structured-chat")
  if (!core.Stage.collect || !core.Stage.toolSelector || !core.Stage.toolInputs || !core.Model.guard)
    throw new Error("Root import failed without TypeSafe")
} finally {
  guard.deregister()
}
const TypeSafe = await import("@popcomputer/structured-chat/typesafe")
const layer = TypeSafe.layer({
  apiKey: Redacted.make("smoke-key"),
  model: "jev-test",
  totalTimeoutMilliseconds: 1_000,
  retry: { maximumAttempts: 1, delayMilliseconds: 0 },
  limits: {
    maximumQuestions: 5,
    maximumStateCharacters: 1_000,
  },
  fetch: async () =>
    Response.json({
      model: "jev-test",
      answers: { ready: { type: "noul", noul: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
})
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* TypeSafe.Service
    return yield* service.evaluate({
      state: "Ready",
      questions: TypeSafe.batch({ ready: TypeSafe.noul("Is the user ready?") }),
    })
  }).pipe(Effect.provide(layer)),
)
if (result.answers.ready.probability !== 1)
  throw new Error("TypeSafe subpath failed")
if (!TypeSafe.detection || !TypeSafe.selection || !TypeSafe.selectionPolicy)
  throw new Error("TypeSafe detection or selection export failed")
process.stdout.write(
  "TypeSafe package smoke passed; root import is independent of the SDK.\n",
)
