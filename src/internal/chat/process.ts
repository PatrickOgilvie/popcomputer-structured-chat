import { ToolContext } from "../../core/tool-context.js"
import {
  readInteractionStageRuntime,
  type InteractionStageDefinitionContract,
  type InteractionCommandContext,
} from "../../core/interaction-stage.js"
import { Predicate, Data, Effect, Result } from "effect"
import type { CollectStageDefinitionContract } from "../../core/collect-stage.js"
import { readCollectStageRuntime } from "../../core/collect-stage.js"
import type { InvalidChatTransition } from "../../core/chat.js"
import type { ConversationMessage } from "../../core/conversation-message.js"
import type {
  CommandStageDefinitionContract,
  ToolStageDefinitionContract,
} from "../../core/stage.js"
import {
  readCommandStageRuntime,
  readToolStageRuntime,
} from "../../core/stage.js"
import type { RepairCorrection } from "../../core/repair.js"
import type { RepairDecision } from "../../core/tool-registry.js"
import { recordDebugEvent } from "../../core/debug-trace.js"

/** Runtime-erased persisted state used only after definition-owned decoding. */
export interface RuntimeChatState {
  readonly schemaVersion: number
  readonly chat: string
  readonly stage: number
  readonly status: "active" | "complete"
  readonly stages: Readonly<
    Partial<
      Record<string, ReturnType<typeof readCollectStageRuntime>["initialState"]>
    >
  >
  readonly repair?: {
    readonly pendingStages: ReadonlyArray<number>
  }
}

type ActiveNode = Data.TaggedEnum<{
  Collect: { readonly stage: CollectStageDefinitionContract }
  Tool: { readonly stage: ToolStageDefinitionContract }
  Command: { readonly stage: CommandStageDefinitionContract }
  Interaction: { readonly stage: InteractionStageDefinitionContract }
}>

const ActiveNode = Data.taggedEnum<ActiveNode>()

interface ProcessInput {
  readonly chat: string
  readonly stages: ReadonlyArray<
    | CollectStageDefinitionContract
    | ToolStageDefinitionContract
    | CommandStageDefinitionContract
    | InteractionStageDefinitionContract
  >
  readonly finalStageIndex: number
  readonly planRepair:
    | ((
        messages: ReadonlyArray<ConversationMessage>,
      ) => Effect.Effect<RepairDecision, unknown, unknown>)
    | undefined
  readonly invalidTransition: (
    reason: "already_complete" | "invalid_state",
  ) => InvalidChatTransition
  readonly isValidState: (state: RuntimeChatState) => boolean
  readonly isGroundedInMessages: (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
  ) => boolean
  readonly applyRepairs: (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
    corrections: ReadonlyArray<RepairCorrection>,
  ) => Effect.Effect<RuntimeChatState, unknown, unknown>
}

interface Process {
  readonly runChecked: (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
    commandContext?: InteractionCommandContext<unknown>,
    allowRepair?: boolean,
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly runTrusted: (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
    commandContext?: InteractionCommandContext<unknown>,
    allowRepair?: boolean,
  ) => Effect.Effect<unknown, unknown, unknown>
}

/** Build the private finite transition process for one compiled chat. */
export const make = (input: ProcessInput): Process => {
  const locate = (
    state: RuntimeChatState,
  ): Result.Result<ActiveNode, InvalidChatTransition> => {
    if (state.status === "complete") {
      return Result.fail(input.invalidTransition("already_complete"))
    }

    const stage = input.stages[state.stage]

    if (stage === undefined) {
      return Result.fail(input.invalidTransition("invalid_state"))
    }

    switch (stage._tag) {
      case "CollectStage":
        return Result.succeed(ActiveNode.Collect({ stage }))
      case "ToolStage":
        return Result.succeed(ActiveNode.Tool({ stage }))
      case "InteractionStage":
        return Result.succeed(ActiveNode.Interaction({ stage }))
      case "CommandStage":
        return Result.succeed(ActiveNode.Command({ stage }))
    }
  }

  const runTrusted = (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
    commandContext?: InteractionCommandContext<unknown>,
    allowRepair = false,
  ): Effect.Effect<unknown, unknown, unknown> =>
    Effect.suspend(() => {
      const planned = locate(state)

      if (Result.isFailure(planned)) {
        return Effect.fail(planned.failure)
      }

      const node = planned.success

      switch (node._tag) {
        case "Interaction": {
          if (commandContext === undefined)
            return Effect.fail(input.invalidTransition("invalid_state"))

          return readInteractionStageRuntime(node.stage)
            .run(messages, commandContext)
            .pipe(
              Effect.map(({ complete, execution }) => ({
                _tag: complete
                  ? ("Complete" as const)
                  : ("ToolResult" as const),
                stage: node.stage.name,
                state: complete
                  ? { ...state, status: "complete" as const }
                  : state,
                result: execution,
              })),
            )
        }

        case "Command": {
          if (commandContext === undefined) {
            return Effect.fail(input.invalidTransition("invalid_state"))
          }

          const runtime = readCommandStageRuntime(node.stage)

          return runtime.runScoped(messages, commandContext).pipe(
            Effect.map((result) => ({
              _tag: "Complete" as const,
              stage: node.stage.name,
              state: { ...state, status: "complete" as const },
              result,
            })),
          )
        }

        case "Tool": {
          const runtime = readToolStageRuntime(node.stage)

          if (allowRepair && input.planRepair !== undefined) {
            return input.planRepair(messages).pipe(
              Effect.flatMap((decision) => {
                if (Predicate.isTagged(decision, "Query")) {
                  return decision.execute.pipe(
                    Effect.map((result) => ({
                      _tag: "ToolResult" as const,
                      stage: node.stage.name,
                      state,
                      result,
                    })),
                  )
                }

                return input
                  .applyRepairs(state, messages, decision.proposal.corrections)
                  .pipe(
                    Effect.flatMap((repairedState) => {
                      const continueTurn = Effect.suspend(() =>
                        runTrusted(
                          repairedState,
                          messages,
                          commandContext,
                          false,
                        ),
                      )

                      const from = input.stages[state.stage]
                      const to = input.stages[repairedState.stage]

                      return repairedState.stage === state.stage ||
                        from === undefined ||
                        to === undefined
                        ? continueTurn
                        : recordDebugEvent({
                            _tag: "StageAdvanced",
                            from: from.name,
                            to: to.name,
                          }).pipe(Effect.andThen(continueTurn))
                    }),
                  )
              }),
            )
          }

          return runtime.run(messages).pipe(
            Effect.map((result) =>
              runtime.afterExecution === "complete"
                ? {
                    _tag: "Complete" as const,
                    stage: node.stage.name,
                    state: { ...state, status: "complete" as const },
                    result,
                  }
                : {
                    _tag: "ToolResult" as const,
                    stage: node.stage.name,
                    state,
                    result,
                  },
            ),
          )
        }

        case "Collect": {
          const runtime = readCollectStageRuntime(node.stage)
          const collectState = state.stages[node.stage.name]

          if (collectState === undefined) {
            return Effect.fail(input.invalidTransition("invalid_state"))
          }

          return runtime.run({ state: collectState, messages }).pipe(
            Effect.flatMap((turn) => {
              const nextState: RuntimeChatState = {
                ...state,
                stages: {
                  ...state.stages,
                  [node.stage.name]: turn.state,
                },
              }

              if (!turn.complete) {
                return Effect.succeed({
                  _tag: "Question" as const,
                  stage: node.stage.name,
                  state: nextState,
                  question: turn.question,
                })
              }

              const pendingStages = state.repair?.pendingStages ?? []

              const remainingPending =
                pendingStages[0] === state.stage
                  ? pendingStages.slice(1)
                  : pendingStages

              const nextStage =
                pendingStages.length > 0
                  ? (remainingPending[0] ?? input.finalStageIndex)
                  : state.stage + 1

              const advancedState =
                state.repair === undefined
                  ? { ...nextState, stage: nextStage }
                  : {
                      ...nextState,
                      stage: nextStage,
                      repair: { pendingStages: remainingPending },
                    }

              const continueTurn = Effect.suspend(() =>
                runTrusted(advancedState, messages, commandContext, false),
              )

              const nextStageDefinition = input.stages[nextStage]

              return nextStageDefinition === undefined
                ? continueTurn
                : recordDebugEvent({
                    _tag: "StageAdvanced",
                    from: node.stage.name,
                    to: nextStageDefinition.name,
                  }).pipe(Effect.andThen(continueTurn))
            }),
          )
        }
      }
    }).pipe(
      // Each recursive transition supplies its own accepted state, including
      // planning guards and validators before any tool execution begins.
      Effect.provideService(ToolContext, { stages: state.stages }),
    )

  const runChecked: Process["runChecked"] = (
    state,
    messages,
    commandContext,
    allowRepair = false,
  ) =>
    !input.isValidState(state) || !input.isGroundedInMessages(state, messages)
      ? Effect.fail(input.invalidTransition("invalid_state"))
      : runTrusted(state, messages, commandContext, allowRepair)

  return { runChecked, runTrusted }
}
