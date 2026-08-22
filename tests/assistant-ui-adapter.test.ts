import { Chat } from "../src/index.js"
import * as Debug from "../src/debug.js"
import { describe, expect, test } from "bun:test"
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
  ThreadMessage,
} from "@assistant-ui/react"
import { Schema } from "effect"
import {
  assistantChatSessionMetadataKey,
  makeAssistantChatModelAdapter,
} from "../src/integrations/assistant-ui.js"

const compatibleAdapter: ChatModelAdapter =
  makeAssistantChatModelAdapter({ endpoint: "/api/chat" })

void compatibleAdapter

const userMessage = (text: string): ThreadMessage => ({
  id: `user-${text}`,
  createdAt: new Date(0),
  role: "user",
  content: [{ type: "text", text }],
  attachments: [],
  metadata: { custom: {} },
})

const assistantMessage = (revision: string): ThreadMessage => ({
  id: `assistant-${revision}`,
  createdAt: new Date(0),
  role: "assistant",
  content: [{ type: "text", text: "A prior question" }],
  status: { type: "complete", reason: "stop" },
  metadata: {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {
      [assistantChatSessionMetadataKey]: {
        id: "chat:01",
        revision,
      },
    },
  },
})

const assistantMessageWithInvalidSession = (): ThreadMessage => ({
  id: "assistant-invalid-session",
  createdAt: new Date(0),
  role: "assistant",
  content: [{ type: "text", text: "A prior question" }],
  status: { type: "complete", reason: "stop" },
  metadata: {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {
      [assistantChatSessionMetadataKey]: {
        id: "chat:01",
        revision: 2,
      },
    },
  },
})

const successfulResponseBody = {
  schemaVersion: 1,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Continue" }],
  },
} as const

const successfulDebugResponseBody = {
  ...successfulResponseBody,
  debug: {
    schemaVersion: 1,
    chat: { name: "debug_chat", version: 1 },
    status: "active",
    currentStage: {
      index: 0,
      name: "debug_brief",
      kind: "collect",
    },
    stages: [
      {
        _tag: "CollectStage",
        index: 0,
        name: "debug_brief",
        status: "current",
        repairPending: false,
        satisfiedFields: 0,
        totalFields: 1,
        fields: [
          {
            field: "topic",
            mode: "semantic",
            description: "The topic the user wants to explore",
            question: {
              _tag: "FixedQuestion",
              text: "What should we explore?",
            },
            state: { _tag: "Missing" },
          },
        ],
      },
    ],
  },
} as const

const successfulResponse = (): Response =>
  new Response(JSON.stringify(successfulResponseBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

const runOptions = (
  messages: ReadonlyArray<ThreadMessage>,
): ChatModelRunOptions => ({
  messages,
  runConfig: {},
  abortSignal: new AbortController().signal,
  context: {},
  unstable_getMessage: () => messages.at(-1) ?? userMessage("fallback"),
})

const runAdapter = async (
  result: ReturnType<
    ReturnType<typeof makeAssistantChatModelAdapter>["run"]
  >,
): Promise<ChatModelRunResult> => result

describe("makeAssistantChatModelAdapter", () => {
  test("sends only current text and the latest opaque revision", async () => {
    const requests: Array<{ readonly input: string; readonly init: RequestInit }> =
      []
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: (input, init) => {
        requests.push({ input, init })
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              session: { id: "chat:01", revision: "3" },
              message: {
                role: "assistant",
                content: [
                  {
                    type: "data",
                    name: "agency_cards",
                    data: { schemaVersion: 1, agencies: [] },
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
      },
    })
    const abortSignal = new AbortController().signal
    const result = await runAdapter(
      adapter.run(
        {
          ...runOptions([
            userMessage("An older message"),
            assistantMessage("2"),
            userMessage("The current answer"),
          ]),
          abortSignal,
        },
      ),
    )
    const body = Schema.decodeUnknownSync(
      Schema.fromJsonString(Chat.TurnRequestSchema),
    )(String(requests[0]?.init.body))

    expect(requests[0]?.input).toBe("/api/chat")
    expect(requests[0]?.init.signal).toBe(abortSignal)
    expect(body).toEqual({
      session: { id: "chat:01", revision: "2" },
      message: "The current answer",
    })
    expect(body).not.toHaveProperty("messages")
    expect(body).not.toHaveProperty("state")
    expect(result.metadata?.custom).toEqual({
      [assistantChatSessionMetadataKey]: {
        id: "chat:01",
        revision: "3",
      },
    })
    expect(result.content?.[0]).toMatchObject({
      type: "data",
      name: "agency_cards",
    })
  })

  test("rejects attachments before making a request", async () => {
    let requested = false
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () => {
        requested = true
        return Promise.reject(new Error("must not run"))
      },
    })
    await expect(
      adapter.run({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Inspect this file" }],
            attachments: [{}],
            metadata: { custom: {} },
          },
        ],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("Attachments are not supported")
    expect(requested).toBe(false)
  })

  test.each([
    ["no final message", []],
    ["an assistant final message", [assistantMessage("2")]],
    ["a blank user final message", [userMessage("   ")]],
  ] as const)("rejects %s before making a request", async (_name, messages) => {
    let requested = false
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () => {
        requested = true
        return Promise.reject(new Error("must not run"))
      },
    })

    await expect(adapter.run(runOptions(messages))).rejects.toThrow()
    expect(requested).toBe(false)
  })

  test("omits invalid prior session metadata from the request", async () => {
    const requests: Array<RequestInit> = []
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: (_input, init) => {
        requests.push(init)
        return Promise.resolve(successfulResponse())
      },
    })

    await adapter.run(
      runOptions([
        assistantMessageWithInvalidSession(),
        userMessage("The current answer"),
      ]),
    )
    const body = Schema.decodeUnknownSync(
      Schema.fromJsonString(Chat.TurnRequestSchema),
    )(String(requests[0]?.body))

    expect(body).toEqual({ message: "The current answer" })
    expect(body).not.toHaveProperty("session")
  })

  test("maps a non-success response to a generic availability error", async () => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () =>
        Promise.resolve(
          new Response("private upstream detail", { status: 503 }),
        ),
    })

    await expect(
      adapter.run(runOptions([userMessage("Continue")])),
    ).rejects.toHaveProperty(
      "message",
      "Structured chat is temporarily unavailable",
    )
  })

  test("maps invalid JSON to a generic invalid-response error", async () => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () => Promise.resolve(new Response("not-json", { status: 200 })),
    })

    await expect(
      adapter.run(runOptions([userMessage("Continue")])),
    ).rejects.toHaveProperty(
      "message",
      "Structured chat returned an invalid response",
    )
  })

  test.each([
    [
      "a schema-invalid body",
      {
        ...successfulResponseBody,
        schemaVersion: 2,
      },
    ],
    [
      "an excess response property",
      {
        ...successfulResponseBody,
        unexpected: true,
      },
    ],
    ["an unsolicited debug projection", successfulDebugResponseBody],
  ] as const)("rejects %s", async (_name, responseBody) => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    })

    await expect(
      adapter.run(runOptions([userMessage("Continue")])),
    ).rejects.toHaveProperty(
      "message",
      "Structured chat returned an invalid response",
    )
  })

  test("returns empty custom metadata when a successful response has no session", async () => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat",
      fetch: () => Promise.resolve(successfulResponse()),
    })

    const result = await runAdapter(
      adapter.run(runOptions([userMessage("Continue")])),
    )

    expect(result).toEqual({
      content: successfulResponseBody.message.content,
      metadata: { custom: {} },
    })
  })

  test("delivers an explicitly requested debug snapshot outside message metadata", async () => {
    const snapshots: Array<Debug.Snapshot> = []
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat/debug",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(successfulDebugResponseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      onDebugSnapshot: (snapshot) => {
        snapshots.push(snapshot)
      },
    })

    const result = await runAdapter(
      adapter.run(runOptions([userMessage("Continue")])),
    )

    expect(snapshots).toEqual([successfulDebugResponseBody.debug])
    expect(result.content).toEqual(successfulResponseBody.message.content)
    expect(result.metadata?.custom).toEqual({})
    expect(result.metadata?.custom).not.toHaveProperty("debug")
  })

  test("requires the debug response contract when a callback is configured", async () => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat/debug",
      fetch: () => Promise.resolve(successfulResponse()),
      onDebugSnapshot: () => undefined,
    })

    await expect(
      adapter.run(runOptions([userMessage("Continue")])),
    ).rejects.toHaveProperty(
      "message",
      "Structured chat returned an invalid response",
    )
  })

  test("rejects nested excess debug data before notifying the observer", async () => {
    let notified = false
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat/debug",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...successfulDebugResponseBody,
              debug: {
                ...successfulDebugResponseBody.debug,
                currentStage: {
                  ...successfulDebugResponseBody.debug.currentStage,
                  unexpected: true,
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      onDebugSnapshot: () => {
        notified = true
      },
    })

    await expect(
      adapter.run(runOptions([userMessage("Continue")])),
    ).rejects.toHaveProperty(
      "message",
      "Structured chat returned an invalid response",
    )
    expect(notified).toBe(false)
  })

  test.each([
    [
      "synchronous",
      () => {
        throw new Error("debug observer failed")
      },
    ],
    [
      "asynchronous",
      () => Promise.reject(new Error("debug observer failed")),
    ],
  ] as const)("isolates %s debug observer failures", async (_name, observe) => {
    const adapter = makeAssistantChatModelAdapter({
      endpoint: "/api/chat/debug",
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(successfulDebugResponseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      onDebugSnapshot: observe,
    })

    const result = await runAdapter(
      adapter.run(runOptions([userMessage("Continue")])),
    )

    expect(result.content).toEqual(successfulResponseBody.message.content)
  })
})
