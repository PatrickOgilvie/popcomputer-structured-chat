import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as TypeSafe from "../src/typesafe.js"

/** Configuration shared by Node and workerd adapter tests. */
export const runtimeConfig = (
  fetch: NonNullable<TypeSafe.Config["fetch"]>,
): TypeSafe.Config => ({
  apiKey: Redacted.make("runtime-test-key"),
  model: "jev-test",
  totalTimeoutMilliseconds: 1_000,
  retry: { maximumAttempts: 1, delayMilliseconds: 0 },
  limits: {
    maximumQuestions: 20,
    maximumStateCharacters: 10_000,
  },
  fetch,
})
/** Exercise the real SDK's fetch cancellation under the caller's Effect lifetime. */
export const cancellationCase = () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let aborted = false
    let requests = 0
    const layer = TypeSafe.layer(
      runtimeConfig(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            requests += 1
            const signal = init?.signal
            if (signal === undefined || signal === null)
              throw new Error("Missing cancellation signal")
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                reject(new Error("aborted"))
              },
              { once: true },
            )
            Effect.runSync(Deferred.succeed(started, undefined))
          }),
      ),
    )
    const fiber = yield* Effect.gen(function* () {
      const service = yield* TypeSafe.Service
      return yield* service.evaluate({
        state: "private runtime text",
        questions: TypeSafe.batch({
          ready: TypeSafe.noul("Is the user ready?"),
        }),
      })
    }).pipe(Effect.provide(layer), Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    return {
      aborted,
      requests,
      interrupted:
        Exit.isFailure(exit) &&
        exit.cause.reasons.some(Cause.isInterruptReason),
      failed:
        Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isFailReason),
    }
  })
/** A virtual-clock deadline aborts an outstanding SDK request. */
export const timeoutCase = () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let aborted = false
    const layer = TypeSafe.layer(
      runtimeConfig(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true
                reject(new Error("aborted"))
              },
              { once: true },
            )
            Effect.runSync(Deferred.succeed(started, undefined))
          }),
      ),
    )
    const fiber = yield* Effect.gen(function* () {
      const service = yield* TypeSafe.Service
      return yield* service.evaluate({
        state: "Ready",
        questions: TypeSafe.batch({
          ready: TypeSafe.noul("Is the user ready?"),
        }),
      })
    }).pipe(Effect.provide(layer), Effect.result, Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust(1_000)
    const result = yield* Fiber.join(fiber)
    return { aborted, result }
  }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer())))
