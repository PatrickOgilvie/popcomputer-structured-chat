import { Effect, Function as Fn, Schema } from "effect"
import type { AnyDefinition } from "../Chat.js"
import {
  ChatContext,
  ChatContextUnavailable,
  type ChatOutcome,
} from "./chat-context.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import {
  ToolNameSchema,
  ToolDescriptionSchema,
  type ToolSchema,
} from "./tool.js"

/** @internal Input and output contracts attached to a composable chat. */
export interface ChatContract {
  readonly inputSchema: ToolSchema
  readonly outputSchema: ToolSchema
}

/** Input accepted by a chat; an unparameterized chat accepts null. */
export type InputOf<C> = C extends {
  readonly composition: { readonly inputSchema: infer S extends ToolSchema }
}
  ? Schema.Schema.Type<S>
  : null

/** Output returned by a chat; an unparameterized chat returns null. */
export type OutputOf<C> = C extends {
  readonly composition: { readonly outputSchema: infer S extends ToolSchema }
}
  ? Schema.Schema.Type<S>
  : null

interface BranchRuntime {
  readonly bind: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- sealed resolver receives arguments already parsed by its definition-owned tool codec
    arguments_: unknown,
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly outputSchema: ToolSchema
}

const branchRuntime = Symbol("@popcomputer/structured-chat/BranchRuntime")

/** A declared call to another independently runnable chat. */
export interface BranchContract extends StructuredDefinition<"chat_branch"> {
  readonly _tag: "ChatBranch"
  readonly name: string
  readonly description: string
  readonly chat: AnyDefinition
  readonly argumentsSchema: ToolSchema
  readonly [branchRuntime]: BranchRuntime
}

/** A branch retains the child's contracts and its input resolver's Effects. */
export interface Branch<
  Name extends string,
  Arguments extends ToolSchema,
  Child extends AnyDefinition,
  Error,
  Requirements,
> extends BranchContract {
  readonly name: Name
  readonly chat: Child
  readonly argumentsSchema: Arguments
  readonly input: (
    arguments_: Schema.Schema.Type<Arguments>,
  ) => Effect.Effect<InputOf<Child>, Error, Requirements>
}

/** Readonly declared branches available to a chat. */
export type Branches = ReadonlyArray<BranchContract>

/** @internal Compile one typed branch input resolver as a closed capability. */
export const defineBranch = <
  const Name extends string,
  Arguments extends ToolSchema,
  Child extends AnyDefinition,
  Error,
  Requirements,
>(
  input: {
    readonly name: Name
    readonly description: string
    readonly chat: Child
    readonly arguments: Arguments
    readonly input: (
      arguments_: Schema.Schema.Type<Arguments>,
    ) => Effect.Effect<InputOf<Child>, Error, Requirements>
  },
  contract: ChatContract,
): Branch<Name, Arguments, Child, Error, Requirements> => {
  Schema.decodeSync(ToolNameSchema)(input.name)
  Schema.decodeSync(ToolDescriptionSchema)(input.description)
  return structuredDefinition("chat_branch")({
    _tag: "ChatBranch" as const,
    name: input.name,
    description: input.description,
    chat: input.chat,
    argumentsSchema: input.arguments,
    input: input.input,
    [branchRuntime]: {
      // SAFETY: only the branch's own parsed argument schema reaches this erased runtime binding.
      bind: Fn.cast<typeof input.input, BranchRuntime["bind"]>(input.input),
      outputSchema: contract.outputSchema,
    },
  })
}

/** @internal Read sealed branch contracts and the input resolver. */
export const readBranch = (branch: BranchContract): BranchRuntime =>
  branch[branchRuntime]

/** Read the latest completed or cancelled call to this branch in the current invocation. */
export const returned = <B extends BranchContract>(
  branch: B,
): Effect.Effect<
  ChatOutcome<OutputOf<B["chat"]>>,
  ChatContextUnavailable,
  ChatContext
> =>
  Effect.gen(function* () {
    const context = yield* ChatContext
    const entry = context.returns
      .filter((value) => value.branch === branch)
      .at(-1)
    if (entry === undefined)
      return yield* Effect.fail(
        new ChatContextUnavailable({ reason: "missing_return" }),
      )
    if (entry.outcome._tag === "Cancelled") return entry.outcome
    const output = yield* Schema.decodeUnknownEffect(
      Schema.toType(readBranch(branch).outputSchema),
    )(entry.outcome.output).pipe(
      Effect.mapError(
        () => new ChatContextUnavailable({ reason: "invalid_return" }),
      ),
    )
    // SAFETY: the sealed branch carries this child's exact output codec.
    return {
      _tag: "Completed" as const,
      output: Fn.cast<typeof output, OutputOf<B["chat"]>>(output),
    }
  })
