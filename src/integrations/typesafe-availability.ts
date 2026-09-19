import { Effect, Schema } from "effect"
import type { EvaluationError } from "../core/evaluation.js"
import { recordDebugEvent } from "../core/debug-trace.js"

/** Recovery after the evaluator's bounded retries and deadline are exhausted. */
export const UnavailablePolicySchema = Schema.Literals(["fail", "fallback"])
export type UnavailablePolicy = typeof UnavailablePolicySchema.Type

/** @internal Recover only transient unavailability; retain its cause in diagnostics. */
export const withUnavailableFallback =
  (policy: UnavailablePolicy, operation: "detection" | "selection") =>
  <A, R>(effect: Effect.Effect<A, EvaluationError, R>) =>
    effect.pipe(
      Effect.catchTag("TypeSafeUnavailable", (error) => {
        if (policy === "fail") return Effect.fail(error)
        return Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            fallback: "llm",
            unavailableReason: error.reason,
          })
          yield* recordDebugEvent({
            _tag: "TypeSafeFallback",
            operation,
            reason: error.reason,
          })
          return {
            _tag: "NotApplicable",
            reason: "provider_unavailable",
          } as const
        })
      }),
    )
