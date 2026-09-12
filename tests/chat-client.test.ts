import { expect, test } from "bun:test"
import { Result } from "effect"
import {
  ChatClientCancelled,
  makeChatTurnClient,
  makeChatDebugTurnClient,
  makeChatExplorationClient,
  type ChatClientError,
} from "../src/integrations/chat-client.js"

const notice = {
  schemaVersion: 2,
  message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
} as const

const failedDebug = {
  schemaVersion: 2,
  outcome: "failure",
  session: null,
  trace: { schemaVersion: 1, events: [] },
} as const

const expectFailure = (
  result: Result.Result<unknown, ChatClientError>,
  reason: string,
) => {
  expect(Result.isFailure(result)).toBe(true)

  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason })
}

test("turn client encodes only the strict request and parses a notice", async () => {
  const requests: RequestInit[] = []

  const client = makeChatTurnClient({
    endpoint: "/chat",
    fetch: async (endpoint, init) => {
      expect(endpoint).toBe("/chat")
      requests.push(init)

      return Response.json(notice)
    },
  })

  const result = await client.run({ message: "Hello" })
  expect(result).toEqual(Result.succeed(notice))
  expect(requests[0]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    body: '{"message":"Hello"}',
  })
  expectFailure(await client.run({ message: "" }), "invalid_request")
  expect(requests).toHaveLength(1)
})

test("transport failures are typed and omit upstream details", async () => {
  const client = makeChatTurnClient({
    endpoint: "/chat",
    fetch: async () => {
      throw new Error("secret upstream details")
    },
  })

  const result = await client.run({ message: "Hello" })
  expectFailure(result, "request_failed")

  if (Result.isFailure(result)) {
    expect(result.failure.operation).toBe("turn")
    expect(JSON.stringify(result.failure)).not.toContain("secret")
  }
})

test.each([
  [200, "not json", "invalid_response"],
  [200, JSON.stringify({ ...notice, debug: {} }), "invalid_response"],
  [503, JSON.stringify(notice), "request_failed"],
] as const)(
  "ordinary status/body boundary: %s %j",
  async (status, body, reason) => {
    const client = makeChatTurnClient({
      endpoint: "/chat",
      fetch: async () => new Response(body, { status }),
    })

    expectFailure(await client.run({ message: "Hello" }), reason)
  },
)

test.each([200, 503])(
  "debug failures remain observable envelopes on HTTP %s",
  async (status) => {
    const client = makeChatDebugTurnClient({
      endpoint: "/debug",
      fetch: async () => Response.json(failedDebug, { status }),
    })

    expect(await client.run({ message: "Hello" })).toEqual(
      Result.succeed(failedDebug),
    )
  },
)

test.each([200, 503])(
  "invalid debug envelopes have a status-specific failure on HTTP %s",
  async (status) => {
    const client = makeChatDebugTurnClient({
      endpoint: "/debug",
      fetch: async () =>
        Response.json({ ...failedDebug, extra: "secret" }, { status }),
    })

    expectFailure(
      await client.run({ message: "Hello" }),
      status === 200 ? "invalid_response" : "request_failed",
    )
  },
)

test("explorations share the strict request and transport boundary", async () => {
  let calls = 0

  const client = makeChatExplorationClient({
    endpoint: "/explore",
    fetch: async () => {
      calls += 1

      return Response.json({
        schemaVersion: 1,
        content: [{ type: "text", text: "Found" }],
      })
    },
  })

  const input = {
    session: { id: "chat:1" },
    call: { name: "inspect", arguments: {} },
  }

  expect(Result.isSuccess(await client.run(input))).toBe(true)
  expectFailure(
    await client.run({ ...input, session: { id: "" } }),
    "invalid_request",
  )
  expect(calls).toBe(1)
})

test("pre-abort skips fetch and retains an opaque non-enumerable cause", async () => {
  const controller = new AbortController()
  const cause = { private: "cancellation details" }
  controller.abort(cause)
  let calls = 0

  const client = makeChatTurnClient({
    endpoint: "/chat",
    fetch: async () => {
      calls += 1

      return Response.json(notice)
    },
  })

  const result = await client.run(
    { message: "Hello" },
    { signal: controller.signal },
  )

  expectFailure(result, "cancelled")
  expect(calls).toBe(0)

  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(ChatClientCancelled)
    expect(result.failure.cause).toBe(cause)
    expect(JSON.stringify(result.failure)).not.toContain("cancellation details")
  }
})

test("abort after fetch suppresses the response", async () => {
  const controller = new AbortController()

  const client = makeChatTurnClient({
    endpoint: "/chat",
    fetch: async () => {
      controller.abort()

      return Response.json(notice)
    },
  })

  expectFailure(
    await client.run({ message: "Hello" }, { signal: controller.signal }),
    "cancelled",
  )
})

test("body AbortError is cancellation even if the supplied signal is live", async () => {
  const cause = new DOMException("Body cancelled", "AbortError")

  const client = makeChatTurnClient({
    endpoint: "/chat",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cause)
          },
        }),
      ),
  })

  const result = await client.run(
    { message: "Hello" },
    { signal: new AbortController().signal },
  )

  expectFailure(result, "cancelled")

  if (Result.isFailure(result)) expect(result.failure.cause).toBe(cause)
})

test.each([200, 503])(
  "debug success requires successful HTTP status %s",
  async (status) => {
    const body = {
      ...notice,
      outcome: "success",
      session: { id: "chat:1", revision: "1" },
      answers: {
        schemaVersion: 1,
        chat: { name: "example", version: 1 },
        sections: [],
      },
      debug: {
        schemaVersion: 1,
        chat: { name: "example", version: 1 },
        status: "active",
        currentStage: { index: 0, name: "author", kind: "interaction" },
        stages: [
          {
            _tag: "InteractionStage",
            index: 0,
            name: "author",
            status: "current",
            repairPending: false,
            tools: ["edit"],
            commands: ["edit"],
            completeOn: [],
          },
        ],
      },
      trace: { schemaVersion: 1, events: [] },
    } as const

    const client = makeChatDebugTurnClient({
      endpoint: "/debug",
      fetch: async () => Response.json(body, { status }),
    })

    const result = await client.run({ message: "Hello" })

    if (status === 200) expect(result).toEqual(Result.succeed(body))
    else expectFailure(result, "request_failed")
  },
)

test("a rejected fetch AbortError retains its identity without an aborted signal", async () => {
  const cause = new DOMException("Cancelled", "AbortError")

  const client = makeChatExplorationClient({
    endpoint: "/explore",
    fetch: async () => {
      throw cause
    },
  })

  const result = await client.run({
    session: { id: "chat:1" },
    call: { name: "inspect", arguments: {} },
  })

  expectFailure(result, "cancelled")

  if (Result.isFailure(result)) expect(result.failure.cause).toBe(cause)
})
