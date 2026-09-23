import { isAnswerStage } from "../../core/answer-collection.js"
import { Schema } from "effect"
import { JsonValueSchema } from "../../core/json-value.js"
import {
  InvalidToolPlanningContext,
  type ToolPlanningFrame,
  type ToolStageTrigger,
  type SelectionAcceptedAnswer,
} from "../../core/tool-selection.js"
import type { ToolClarification } from "../../core/tool-planning.js"
import { ToolContext } from "../../core/tool-context.js"
import {
  readInteractionStageRuntime,
  type InteractionStageDefinitionContract,
  type InteractionCommandContext,
} from "../../core/interaction-stage.js"
import { Data, Effect, Result } from "effect"
import type { AnswerStageDefinitionContract } from "../../core/collect-stage.js"
import {
  readCollectStageInspection,
  readCollectStageRuntime,
} from "../../core/collect-stage.js"
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
  Collect: { readonly stage: AnswerStageDefinitionContract }
  Tool: { readonly stage: ToolStageDefinitionContract }
  Command: { readonly stage: CommandStageDefinitionContract }
  Interaction: { readonly stage: InteractionStageDefinitionContract }
}>

const ActiveNode = Data.taggedEnum<ActiveNode>()

interface ProcessInput {
  readonly chat: string
  readonly stages: ReadonlyArray<
    | AnswerStageDefinitionContract
    | ToolStageDefinitionContract
    | CommandStageDefinitionContract
    | InteractionStageDefinitionContract
  >
  readonly finalStageIndex: number
  readonly planRepair:
    | ((
        messages: ReadonlyArray<ConversationMessage>,
        frame?: ToolPlanningFrame,
      ) => Effect.Effect<RepairDecision | ToolClarification, unknown, unknown>)
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
      case "InterviewStage":
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

  const planningFrame = (state: RuntimeChatState, trigger: ToolStageTrigger) =>
    Effect.gen(function* () {
      const accepted: Array<SelectionAcceptedAnswer> = []
      for (const stage of input.stages) {
        if (!isAnswerStage(stage)) continue
        const saved = state.stages[stage.name]
        if (saved === undefined) continue
        for (const field of readCollectStageInspection(stage).fields) {
          const answer = saved.accepted[field.field]
          if (answer === undefined) continue
          const value = yield* field.encodeValue(answer.value).pipe(
            Effect.flatMap((encoded) =>
              Schema.decodeUnknownEffect(JsonValueSchema)(encoded),
            ),
            Effect.mapError(
              () =>
                new InvalidToolPlanningContext({
                  stage: stage.name,
                  field: field.field,
                }),
            ),
          )
          accepted.push({
            stage: stage.name,
            field: field.field,
            value,
            evidence: answer.evidence,
          })
        }
      }
      return { trigger, accepted }
    })

  const runTrusted = (
    state: RuntimeChatState,
    messages: ReadonlyArray<ConversationMessage>,
    commandContext?: InteractionCommandContext<unknown>,
    allowRepair = false,
    trigger: ToolStageTrigger = "user_reply",
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
          const clarify = (result: ToolClarification) => ({
            _tag: "Clarification" as const,
            stage: node.stage.name,
            state,
            clarification: { text: result.text },
          })
          return Effect.gen(function* () {
            const frame = runtime.selectionEnabled
              ? yield* planningFrame(state, trigger)
              : undefined
            if (allowRepair && input.planRepair !== undefined) {
              const decision = yield* input.planRepair(messages, frame)
              if (decision._tag === "Clarification") return clarify(decision)
              if (decision._tag === "Query") {
                const result = yield* decision.execute
                return {
                  _tag: "ToolResult" as const,
                  stage: node.stage.name,
                  state,
                  result,
                }
              }
              const repairedState = yield* input.applyRepairs(
                state,
                messages,
                decision.proposal.corrections,
              )
              const from = input.stages[state.stage]
              const to = input.stages[repairedState.stage]
              if (
                repairedState.stage !== state.stage &&
                from !== undefined &&
                to !== undefined
              )
                yield* recordDebugEvent({
                  _tag: "StageAdvanced",
                  from: from.name,
                  to: to.name,
                })
              return yield* runTrusted(
                repairedState,
                messages,
                commandContext,
                false,
                "after_repair",
              )
            }
            const outcome = yield* runtime.run(messages, frame)
            if (outcome._tag === "Clarification") return clarify(outcome)
            return runtime.afterExecution === "complete"
              ? {
                  _tag: "Complete" as const,
                  stage: node.stage.name,
                  state: { ...state, status: "complete" as const },
                  result: outcome.execution,
                }
              : {
                  _tag: "ToolResult" as const,
                  stage: node.stage.name,
                  state,
                  result: outcome.execution,
                }
          })
        }

        case "Collect": {
          const runtime = readCollectStageRuntime(node.stage)
          const collectState = state.stages[node.stage.name]

          if (collectState === undefined) {
            return Effect.fail(input.invalidTransition("invalid_state"))
          }

          const execution = node.stage._tag === "InterviewStage"
            ? planningFrame(state, state.repair?.pendingStages.includes(state.stage) === true ? "after_repair" : trigger).pipe(Effect.flatMap(frame => runtime.run({ state: collectState, messages, frame })))
            : runtime.run({ state: collectState, messages })
          return execution.pipe(
            Effect.flatMap((turn) => {
              const nextState: RuntimeChatState = {
                ...state,
                stages: {
                  ...state.stages,
                  [node.stage.name]: turn.state,
                },
              }

              if ("action" in turn) return Effect.succeed(turn.action._tag === "Clarification"
                ? { _tag: "Clarification" as const, clarification: { text: turn.action.text }, stage: node.stage.name, state: nextState }
                : { ...turn.action, stage: node.stage.name, state: nextState })
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
                runTrusted(
                  advancedState,
                  messages,
                  commandContext,
                  false,
                  "stage_entered",
                ),
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
