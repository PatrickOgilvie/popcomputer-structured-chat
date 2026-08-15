import { Effect, Schema, unsafeCoerce } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { UntrustedMessage } from "./model.js"
import type { JsonValue } from "./json-value.js"

/** Stable machine-facing name for one model-boundary policy guard. */
export const ModelGuardNameSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(100),
  Schema.pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Safe context supplied before a structured model request begins. */
export interface ModelGuardContext {
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly toolNames: ReadonlyArray<string>
}

/** Strictly parsed model proposal supplied before application execution. */
export interface ModelGuardCall {
  readonly name: string
  readonly arguments: JsonValue
}

/** Safe context supplied after parsing and before a tool executes. */
export interface ModelGuardCallContext extends ModelGuardContext {
  readonly call: ModelGuardCall
}

/** Minimum runtime identity retained for every model-boundary guard. */
export interface ModelGuardDefinitionContract
  extends StructuredDefinition<"model_guard"> {
  readonly _tag: "ModelGuard"
  readonly name: string
}

/** Composable policy checks around one structured model request. */
export interface ModelGuard<Name extends string, Error, Requirements>
  extends ModelGuardDefinitionContract {
  readonly name: Name
  readonly check: (
    context: ModelGuardContext,
  ) => Effect.Effect<void, Error, Requirements>
  readonly checkCall?: (
    context: ModelGuardCallContext,
  ) => Effect.Effect<void, Error, Requirements>
}

/** Definition input for one model-boundary policy guard. */
export interface DefineModelGuardInput<
  Name extends string,
  Error,
  Requirements,
> {
  readonly name: Name
  readonly check: (
    context: ModelGuardContext,
  ) => Effect.Effect<void, Error, Requirements>
  readonly checkCall?: (
    context: ModelGuardCallContext,
  ) => Effect.Effect<void, Error, Requirements>
}

/** Readonly tuple of optional guards applied to one model step. */
export type ModelGuardTuple = ReadonlyArray<ModelGuardDefinitionContract>

type ModelGuardErrorOf<Guard> = Guard extends ModelGuard<
    infer _Name,
    infer Error,
    infer _Requirements
  >
    ? Error
    : never

type ModelGuardRequirementsOf<Guard> = Guard extends ModelGuard<
    infer _Name,
    infer _Error,
    infer Requirements
  >
    ? Requirements
    : never

/** Failure union produced by a tuple of model guards. */
export type ModelGuardError<Guards extends ModelGuardTuple> =
  ModelGuardErrorOf<Guards[number]>

/** Effect service union required by a tuple of model guards. */
export type ModelGuardRequirements<Guards extends ModelGuardTuple> =
  ModelGuardRequirementsOf<Guards[number]>

/** Define Effect-native policy checks around a structured model step. */
export const defineModelGuard = <
  const Name extends string,
  Error,
  Requirements,
>(
  definition: DefineModelGuardInput<Name, Error, Requirements>,
): ModelGuard<Name, Error, Requirements> => {
  Schema.decodeSync(ModelGuardNameSchema)(definition.name)

  const base = {
    _tag: "ModelGuard",
    name: definition.name,
    check: definition.check,
  } as const
  return structuredDefinition("model_guard")(
    definition.checkCall === undefined
      ? base
      : { ...base, checkCall: definition.checkCall },
  )
}

interface RuntimeModelGuard {
  readonly check: (
    context: ModelGuardContext,
  ) => Effect.Effect<void, unknown, unknown>
  readonly checkCall?: (
    context: ModelGuardCallContext,
  ) => Effect.Effect<void, unknown, unknown>
}

type ModelGuardPhase = "before_model" | "before_tool"

const runtimeModelGuard = (
  guard: ModelGuardDefinitionContract,
): RuntimeModelGuard => {
  // SAFETY: ModelGuardDefinitionContract carries the package-owned nominal
  // identity and can only be constructed by defineModelGuard.
  return unsafeCoerce<ModelGuardDefinitionContract, RuntimeModelGuard>(guard)
}

const runGuardPhase = <Guards extends ModelGuardTuple>(
  guards: Guards,
  phase: ModelGuardPhase,
  run: (
    guard: RuntimeModelGuard,
  ) => Effect.Effect<void, unknown, unknown> | undefined,
): Effect.Effect<
  void,
  ModelGuardError<Guards>,
  ModelGuardRequirements<Guards>
> => {
  const execution = Effect.forEach(
    guards,
    (guard) =>
      (run(runtimeModelGuard(guard)) ?? Effect.void).pipe(
        Effect.withSpan(
          "popcomputer.structured_chat.model_guard.check",
          {
            attributes: { guard: guard.name, phase },
          },
        ),
      ),
    { concurrency: 1, discard: true },
  )

  // SAFETY: guards run sequentially without recovering failures, so the
  // erased Effect has exactly the conditional error and requirement unions.
  return execution as Effect.Effect<
    void,
    ModelGuardError<Guards>,
    ModelGuardRequirements<Guards>
  >
}

/** @internal */
export const runModelGuards = <Guards extends ModelGuardTuple>(
  guards: Guards,
  context: ModelGuardContext,
): Effect.Effect<
  void,
  ModelGuardError<Guards>,
  ModelGuardRequirements<Guards>
> => {
  return runGuardPhase(
    guards,
    "before_model",
    (guard) => guard.check(context),
  )
}

/** @internal Run optional semantic checks on one parsed tool proposal. */
export const runModelCallGuards = <Guards extends ModelGuardTuple>(
  guards: Guards,
  context: ModelGuardCallContext,
): Effect.Effect<
  void,
  ModelGuardError<Guards>,
  ModelGuardRequirements<Guards>
> => {
  return runGuardPhase(
    guards,
    "before_tool",
    (guard) => guard.checkCall?.(context),
  )
}
