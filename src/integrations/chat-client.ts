import { Result, Schema } from "effect"
import {
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
  StructuredChatExplorationRequestSchema,
  StructuredChatExplorationResponseSchema,
  type StructuredChatTurnRequest,
  type StructuredChatTurnResponse,
  type StructuredChatExplorationRequest,
  type StructuredChatExplorationResponse,
} from "../core/protocol.js"
import type { StructuredChatDebugTurnResponse } from "../core/debug-protocol.js"

/** Endpoint contract selected by a client factory. */
export const ChatClientOperationSchema = Schema.Literals([
  "turn",
  "debug_turn",
  "exploration",
])

/** Safe explanation for an unsuccessful HTTP exchange. */
export const ChatClientFailureReasonSchema = Schema.Literals([
  "invalid_request",
  "request_failed",
  "invalid_response",
])

/** An expected client failure without upstream bodies or transport causes. */
export class ChatClientFailure extends Schema.TaggedError<ChatClientFailure>()(
  "ChatClientFailure",
  {
    operation: ChatClientOperationSchema,
    reason: ChatClientFailureReasonSchema,
  },
) {}

/** Cancellation; native Error.cause retains identity for framework translation. */
export class ChatClientCancelled extends Schema.TaggedError<ChatClientCancelled>()(
  "ChatClientCancelled",
  {
    operation: ChatClientOperationSchema,
    reason: Schema.Literal("cancelled"),
  },
) {}

/** Expected outcomes that prevented a valid protocol response. */
export type ChatClientError = ChatClientFailure | ChatClientCancelled

/** Injected HTTP capability, usable in browsers and server runtimes. */
export type ChatClientFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>

/** Dependencies owned by one endpoint client. */
export interface ChatClientOptions {
  readonly endpoint: string
  readonly fetch?: ChatClientFetch
}

/** Cancellation belongs to an invocation, separate from semantic input. */
export interface ChatClientRunOptions {
  readonly signal?: AbortSignal
}

/** Strict ordinary-turn client with all expected outcomes in Result. */
export interface ChatTurnClient {
  readonly run: (
    input: StructuredChatTurnRequest,
    options?: ChatClientRunOptions,
  ) => Promise<Result.Result<StructuredChatTurnResponse, ChatClientError>>
}

/** A valid failure envelope is a successful debug HTTP exchange. */
export interface ChatDebugTurnClient {
  readonly run: (
    input: StructuredChatTurnRequest,
    options?: ChatClientRunOptions,
  ) => Promise<Result.Result<StructuredChatDebugTurnResponse, ChatClientError>>
}

/** Read-only exploration client; requests carry only the session ID. */
export interface ChatExplorationClient {
  readonly run: (
    input: StructuredChatExplorationRequest,
    options?: ChatClientRunOptions,
  ) => Promise<
    Result.Result<StructuredChatExplorationResponse, ChatClientError>
  >
}

type Operation = Schema.Schema.Type<typeof ChatClientOperationSchema>

type FailureReason = Schema.Schema.Type<typeof ChatClientFailureReasonSchema>

const failed = (operation: Operation, reason: FailureReason) =>
  Result.fail(new ChatClientFailure({ operation, reason }))

const cancellation = (
  operation: Operation,
  signal: AbortSignal | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- native cancellation can carry any caller-owned reason
  cause?: unknown,
): ChatClientCancelled | undefined => {
  const aborted = signal?.aborted === true

  if (
    !aborted &&
    !(cause instanceof DOMException && cause.name === "AbortError")
  ) {
    return undefined
  }

  const error = new ChatClientCancelled({ operation, reason: "cancelled" })
  Object.defineProperty(error, "cause", {
    value: aborted ? signal.reason : cause,
    enumerable: false,
  })

  return error
}

interface JsonResponse {
  readonly ok: boolean
  readonly body: unknown
}

/** Own request validation, transport policy, body parsing, and cancellation. */
const postJson = async <Input>(
  operation: Operation,
  schema: Schema.Codec<Input>,
  input: Input,
  options: ChatClientOptions,
  signal: AbortSignal | undefined,
): Promise<Result.Result<JsonResponse, ChatClientError>> => {
  const cancelled = cancellation(operation, signal)

  if (cancelled !== undefined) return Result.fail(cancelled)

  const encoded = Schema.encodeUnknownResult(schema)(input, {
    onExcessProperty: "error",
  })

  if (Result.isFailure(encoded)) return failed(operation, "invalid_request")
  let body: string

  try {
    body = JSON.stringify(encoded.success)
  } catch {
    return failed(operation, "invalid_request")
  }

  const fetch_ = options.fetch ?? globalThis.fetch
  let response: Response

  try {
    const init: RequestInit = {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    }

    if (signal !== undefined) init.signal = signal
    response = await fetch_(options.endpoint, init)
  } catch (cause: unknown) {
    const cancelled = cancellation(operation, signal, cause)

    return cancelled === undefined
      ? failed(operation, "request_failed")
      : Result.fail(cancelled)
  }

  const afterFetch = cancellation(operation, signal)

  if (afterFetch !== undefined) return Result.fail(afterFetch)

  if (!response.ok && operation !== "debug_turn") {
    return failed(operation, "request_failed")
  }

  let responseBody: unknown

  try {
    responseBody = await response.json()
  } catch (cause: unknown) {
    const cancelled = cancellation(operation, signal, cause)

    return cancelled === undefined
      ? failed(operation, response.ok ? "invalid_response" : "request_failed")
      : Result.fail(cancelled)
  }

  const afterBody = cancellation(operation, signal)

  if (afterBody !== undefined) return Result.fail(afterBody)

  return Result.succeed({ ok: response.ok, body: responseBody })
}

const decodeResponse = <Output>(
  operation: Operation,
  schema: Schema.Codec<Output>,
  response: JsonResponse,
  signal: AbortSignal | undefined,
): Result.Result<Output, ChatClientError> => {
  const decoded = Schema.decodeUnknownResult(schema)(response.body, {
    onExcessProperty: "error",
  })

  const cancelled = cancellation(operation, signal)

  if (cancelled !== undefined) return Result.fail(cancelled)

  return Result.isFailure(decoded)
    ? failed(operation, response.ok ? "invalid_response" : "request_failed")
    : Result.succeed(decoded.success)
}

/** Create a client for the ordinary persisted-or-notice response contract. */
export const makeChatTurnClient = (
  options: ChatClientOptions,
): ChatTurnClient => ({
  run: async (input, runOptions = {}) => {
    const response = await postJson(
      "turn",
      StructuredChatTurnRequestSchema,
      input,
      options,
      runOptions.signal,
    )

    if (Result.isFailure(response)) return Result.fail(response.failure)

    return decodeResponse(
      "turn",
      StructuredChatTurnResponseSchema,
      response.success,
      runOptions.signal,
    )
  },
})

/** Create an explicit debug client; debug codecs load only on this path. */
export const makeChatDebugTurnClient = (
  options: ChatClientOptions,
): ChatDebugTurnClient => ({
  run: async (input, runOptions = {}) => {
    const response = await postJson(
      "debug_turn",
      StructuredChatTurnRequestSchema,
      input,
      options,
      runOptions.signal,
    )

    if (Result.isFailure(response)) return Result.fail(response.failure)
    let schema: Schema.Codec<StructuredChatDebugTurnResponse>

    try {
      const protocol = await import("../core/debug-protocol.js")
      schema = protocol.StructuredChatDebugTurnResponseSchema
    } catch (cause: unknown) {
      const cancelled = cancellation("debug_turn", runOptions.signal, cause)

      return cancelled === undefined
        ? failed("debug_turn", "request_failed")
        : Result.fail(cancelled)
    }

    const decoded = decodeResponse(
      "debug_turn",
      schema,
      response.success,
      runOptions.signal,
    )

    if (Result.isFailure(decoded)) return decoded

    if (!response.success.ok && decoded.success.outcome === "success") {
      return failed("debug_turn", "request_failed")
    }

    return decoded
  },
})

/** Create a client for application-authored, non-progressing explorations. */
export const makeChatExplorationClient = (
  options: ChatClientOptions,
): ChatExplorationClient => ({
  run: async (input, runOptions = {}) => {
    const response = await postJson(
      "exploration",
      StructuredChatExplorationRequestSchema,
      input,
      options,
      runOptions.signal,
    )

    if (Result.isFailure(response)) return Result.fail(response.failure)

    return decodeResponse(
      "exploration",
      StructuredChatExplorationResponseSchema,
      response.success,
      runOptions.signal,
    )
  },
})
