import { describe, expect, test } from "bun:test"
import { cast, Effect, Result, Schema } from "effect"
import {
  Answer,
  defineChat,
  defineCommand,
  defineTool,
  Question,
  Repair,
  Stage,
} from "../src/index.js"
import {
  inspectChatState,
  InvalidChatDebugProjection,
  type InspectChatStateOptions,
} from "../src/core/debug.js"

const LaunchDetails = Stage.collect({
  name: "launch_details",
  fields: {
    launchDate: Answer.semantic(Schema.DateFromString, {
      description: "The planned launch date",
      ask: Question.fixed("When should it launch?"),
    }),
    responseStyle: Answer.explicit(
      Schema.Literals(["brief_value", "detailed_value"]),
      {
        description: "How much detail the user wants",
        ask: Question.choice("How much detail would you like?", [
          { label: "Brief response", value: "brief_value" },
          { label: "Detailed response", value: "detailed_value" },
        ]),
      },
    ),
  },
})

const Approval = Stage.collect({
  name: "approval",
  fields: {
    approved: Answer.confirmed(Schema.Boolean, {
      description: "Whether the user approved the request",
      ask: Question.fixed("Should I proceed?"),
    }),
  },
})

const FinishDebug = defineTool({
  name: "finish_debug",
  description: "Finish the debug workflow.",
  input: Schema.Struct({}),
  execute: () => Effect.succeed({ finished: true }),
})

const Finish = Stage.tools({
  name: "finish",
  instructions: ["Finish once."],
  tools: [FinishDebug],
  afterExecution: "complete",
})

const DebugChat = defineChat({
  name: "debug_chat",
  version: 1,
  stages: [LaunchDetails, Approval, Finish],
})

type DebugChatState = Schema.Schema.Type<typeof DebugChat.stateSchema>

const accepted = <Value>(
  value: Value,
  messageIndex = 0,
  quote = "supporting evidence",
) => ({
  value,
  evidence: { messageIndex, quote },
})

const launchDate = new Date("2026-08-17T12:00:00.000Z")

const dateAcceptedState: DebugChatState = {
  ...DebugChat.initialState,
  stages: {
    launch_details: {
      accepted: {
        launchDate: accepted(
          launchDate,
          1,
          "Launch on 17 August 2026",
        ),
      },
      asked: {
        launchDate: {
          messageIndex: 0,
          text: "When should it launch?",
        },
      },
    },
    approval: DebugChat.initialState.stages.approval,
  },
}

const launchDetailsCompleteState: DebugChatState = {
  ...DebugChat.initialState,
  stage: 1,
  stages: {
    launch_details: {
      accepted: {
        launchDate: accepted(launchDate),
        responseStyle: accepted("brief_value"),
      },
      asked: {},
    },
    approval: DebugChat.initialState.stages.approval,
  },
}

const completeState: DebugChatState = {
  ...launchDetailsCompleteState,
  stage: 2,
  status: "complete",
  stages: {
    ...launchDetailsCompleteState.stages,
    approval: {
      accepted: {
        approved: accepted(true, 2, "Yes, proceed"),
      },
      asked: {
        approved: {
          messageIndex: 1,
          text: "Should I proceed?",
        },
      },
    },
  },
}

describe("inspectChatState", () => {
  test("projects initial stage, missing fields, labels, and tool metadata", async () => {
    const snapshot = await Effect.runPromise(
      inspectChatState(DebugChat, DebugChat.initialState),
    )

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      chat: { name: "debug_chat", version: 1 },
      status: "active",
      currentStage: {
        index: 0,
        name: "launch_details",
        kind: "collect",
      },
    })
    expect(snapshot.stages.map(({ status }) => status)).toEqual([
      "current",
      "upcoming",
      "upcoming",
    ])

    const collect = snapshot.stages[0]
    expect(collect?._tag).toBe("CollectStage")
    if (collect?._tag !== "CollectStage") {
      throw new Error("Expected a collect-stage debug projection")
    }
    expect(collect).toMatchObject({
      satisfiedFields: 0,
      totalFields: 2,
      repairPending: false,
    })
    expect(collect.fields.map(({ state }) => state._tag)).toEqual([
      "Missing",
      "Missing",
    ])
    expect(collect.fields[1]?.question).toEqual({
      _tag: "ChoiceQuestion",
      text: "How much detail would you like?",
      options: [
        { label: "Brief response" },
        { label: "Detailed response" },
      ],
    })
    expect(JSON.stringify(collect.fields[1]?.question)).not.toContain(
      "brief_value",
    )

    expect(snapshot.stages[2]).toMatchObject({
      _tag: "ToolStage",
      tools: ["finish_debug"],
      afterExecution: "complete",
    })
  })

  test("distinguishes asked and accepted fields and encodes DateFromString", async () => {
    const askedState: DebugChatState = {
      ...DebugChat.initialState,
      stages: {
        ...DebugChat.initialState.stages,
        launch_details: {
          accepted: {},
          asked: {
            launchDate: {
              messageIndex: 0,
              text: "When should it launch?",
            },
          },
        },
      },
    }
    const askedSnapshot = await Effect.runPromise(
      inspectChatState(DebugChat, askedState),
    )
    const askedStage = askedSnapshot.stages[0]
    if (askedStage?._tag !== "CollectStage") {
      throw new Error("Expected a collect-stage debug projection")
    }
    expect(askedStage.fields[0]?.state).toEqual({
      _tag: "Asked",
      issuedQuestion: {
        messageIndex: 0,
        text: "When should it launch?",
      },
    })

    const acceptedSnapshot = await Effect.runPromise(
      inspectChatState(DebugChat, dateAcceptedState),
    )
    const acceptedStage = acceptedSnapshot.stages[0]
    if (acceptedStage?._tag !== "CollectStage") {
      throw new Error("Expected a collect-stage debug projection")
    }
    expect(acceptedStage.satisfiedFields).toBe(1)
    expect(acceptedStage.fields[0]?.state).toEqual({
      _tag: "Accepted",
      value: "2026-08-17T12:00:00.000Z",
      evidence: {
        messageIndex: 1,
        quote: "Launch on 17 August 2026",
      },
      issuedQuestion: {
        messageIndex: 0,
        text: "When should it launch?",
      },
    })
  })

  test("omits evidence while retaining accepted values and issued questions", async () => {
    const snapshot = await Effect.runPromise(
      inspectChatState(DebugChat, dateAcceptedState, {
        evidence: "omit",
      }),
    )
    const collect = snapshot.stages[0]
    if (collect?._tag !== "CollectStage") {
      throw new Error("Expected a collect-stage debug projection")
    }
    expect(collect.fields[0]?.state).toEqual({
      _tag: "Accepted",
      value: "2026-08-17T12:00:00.000Z",
      evidence: null,
      issuedQuestion: {
        messageIndex: 0,
        text: "When should it launch?",
      },
    })
  })

  test("projects current and completed stages positionally", async () => {
    const current = await Effect.runPromise(
      inspectChatState(DebugChat, launchDetailsCompleteState),
    )
    expect(current.currentStage).toEqual({
      index: 1,
      name: "approval",
      kind: "collect",
    })
    expect(current.stages.map(({ status }) => status)).toEqual([
      "complete",
      "current",
      "upcoming",
    ])

    const complete = await Effect.runPromise(
      inspectChatState(DebugChat, completeState),
    )
    expect(complete.status).toBe("complete")
    expect(complete.currentStage).toEqual({
      index: 2,
      name: "finish",
      kind: "tool",
    })
    expect(complete.stages.map(({ status }) => status)).toEqual([
      "complete",
      "complete",
      "complete",
    ])
  })

  test("marks repair stages without treating prefilled later stages as current", async () => {
    const RepairFirst = Stage.collect({
      name: "repair_first",
      fields: {
        first: Answer.semantic(Schema.String, {
          description: "The first repairable answer",
          ask: Question.fixed("What is the first answer?"),
        }),
      },
    })
    const RepairSecond = Stage.collect({
      name: "repair_second",
      fields: {
        second: Answer.semantic(Schema.String, {
          description: "The second repairable answer",
          ask: Question.fixed("What is the second answer?"),
        }),
      },
    })
    const Repeat = Stage.tools({
      name: "repeat",
      instructions: ["Repeat safely."],
      tools: [FinishDebug],
    })
    const RepairChat = defineChat({
      name: "repair_debug_chat",
      version: 1,
      stages: [RepairFirst, RepairSecond, Repeat],
      repair: Repair.standard(),
    })
    type RepairChatState = Schema.Schema.Type<
      typeof RepairChat.stateSchema
    >
    const repairState: RepairChatState = {
      ...RepairChat.initialState,
      stages: {
        repair_first: RepairChat.initialState.stages.repair_first,
        repair_second: {
          accepted: {
            second: accepted("already known"),
          },
          asked: {},
        },
      },
      repair: { pendingStages: [0] },
    }

    const snapshot = await Effect.runPromise(
      inspectChatState(RepairChat, repairState),
    )
    expect(snapshot.stages).toMatchObject([
      {
        _tag: "CollectStage",
        status: "current",
        repairPending: true,
      },
      {
        _tag: "CollectStage",
        status: "upcoming",
        repairPending: false,
        satisfiedFields: 1,
      },
      {
        _tag: "ToolStage",
        status: "upcoming",
        repairPending: false,
      },
    ])
  })

  test("projects terminal command metadata", async () => {
    const Submit = defineCommand({
      name: "submit_debug",
      description: "Submit the debug request once.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ submitted: true }),
    })
    const Submission = Stage.command({
      name: "submission",
      instructions: ["Submit once."],
      command: Submit,
    })
    const CommandChat = defineChat({
      name: "command_debug_chat",
      version: 1,
      stages: [Submission],
    })

    const snapshot = await Effect.runPromise(
      inspectChatState(CommandChat, CommandChat.initialState),
    )
    expect(snapshot.currentStage.kind).toBe("command")
    expect(snapshot.stages).toEqual([
      {
        _tag: "CommandStage",
        index: 0,
        name: "submission",
        status: "current",
        repairPending: false,
        command: "submit_debug",
      },
    ])
  })

  test("returns safe typed failures for non-JSON values and invalid options", async () => {
    const BigIntDetails = Stage.collect({
      name: "bigint_details",
      fields: {
        amount: Answer.semantic(Schema.BigInt, {
          description: "A deliberately non-JSON answer",
          ask: Question.fixed("What is the amount?"),
        }),
      },
    })
    const BigIntChat = defineChat({
      name: "bigint_debug_chat",
      version: 1,
      stages: [BigIntDetails, Finish],
    })
    type BigIntChatState = Schema.Schema.Type<
      typeof BigIntChat.stateSchema
    >
    const bigintState: BigIntChatState = {
      ...BigIntChat.initialState,
      stage: 1,
      stages: {
        bigint_details: {
          accepted: { amount: accepted(1n) },
          asked: {},
        },
      },
    }
    const invalidValue = await Effect.runPromise(
      Effect.result(inspectChatState(BigIntChat, bigintState)),
    )
    expect(Result.isFailure(invalidValue)).toBe(true)
    if (Result.isFailure(invalidValue)) {
      expect(invalidValue.failure).toBeInstanceOf(
        InvalidChatDebugProjection,
      )
      expect(invalidValue.failure.reason).toBe("invalid_answer_value")
    }

    // SAFETY: this test intentionally violates the typed options boundary to
    // prove the runtime schema rejects excess properties.
    const invalidOptions = cast<
      { readonly evidence: "include"; readonly extra: boolean },
      InspectChatStateOptions
    >({ evidence: "include", extra: true })
    const invalidOptionResult = await Effect.runPromise(
      Effect.result(
        inspectChatState(
          DebugChat,
          DebugChat.initialState,
          invalidOptions,
        ),
      ),
    )
    expect(Result.isFailure(invalidOptionResult)).toBe(true)
    if (Result.isFailure(invalidOptionResult)) {
      expect(invalidOptionResult.failure.reason).toBe("invalid_options")
    }
  })
})
