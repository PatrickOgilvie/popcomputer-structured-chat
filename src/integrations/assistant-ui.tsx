import {
  makeAssistantDataUI,
} from "@assistant-ui/core/react"
import { Exit, Result, Schema } from "effect"
import { createElement, type ComponentType, type FC } from "react"
import type { StructuredChatDebugSnapshot } from "../core/debug.js"
import type { StructuredChatDebugTurn } from "../core/debug-protocol.js"
import type {
  ViewData,
  ViewDefinitionContract,
} from "../core/view.js"
import {
  type StructuredChatSessionReference,
  type StructuredChatAssistantMessage,
  type StructuredChatTurnResponse,
  type StructuredChatExplorationRequest,
  type StructuredChatExplorationResponse,
  StructuredChatExplorationRequestSchema,
  StructuredChatExplorationResponseSchema,
  StructuredChatSessionReferenceSchema,
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
} from "../core/protocol.js"
import { JsonValueSchema } from "../core/json-value.js"
import type { StructuredChatUserAnswerUpdate as UserAnswerUpdate } from "./assistant-ui-user-answers.js"

export {
  createStructuredChatUserAnswerStore,
  useStructuredChatUserAnswers,
} from "./assistant-ui-user-answers.js"
export type {
  StructuredChatUserAnswerStore,
  StructuredChatUserAnswerUpdate,
} from "./assistant-ui-user-answers.js"

/** Runtime status supplied by assistant-ui to a data-part renderer. */
export type AssistantViewPartStatus =
  | { readonly type: "running" }
  | { readonly type: "complete" }
  | {
      readonly type: "incomplete"
      readonly reason:
        | "cancelled"
        | "length"
        | "content-filter"
        | "other"
        | "error"
      readonly error?: unknown
    }
  | { readonly type: "requires-action"; readonly reason: "interrupt" }

/** Stable data-part props consumed without exposing assistant-ui internals. */
export interface AssistantDataMessagePartProps<Data = unknown> {
  readonly type: "data"
  readonly name: string
  readonly data: Data
  readonly status: AssistantViewPartStatus
}

/** Parsed props supplied to one schema-bound assistant-ui data renderer. */
export type AssistantViewRenderProps<View extends ViewDefinitionContract> =
  Omit<AssistantDataMessagePartProps, "data"> & {
    readonly data: ViewData<View>
  }

/** Renderer and safe fallback for one schema-bound assistant-ui view. */
export interface AssistantViewConfig<View extends ViewDefinitionContract> {
  readonly render: ComponentType<AssistantViewRenderProps<View>>
  readonly fallback?: ComponentType<AssistantDataMessagePartProps>
}

/** Structural data-UI component returned by assistant-ui registration. */
export type AssistantDataUI = FC & {
  readonly unstable_data: {
    readonly name: string
    readonly render: ComponentType<AssistantDataMessagePartProps>
  }
}

/**
 * Register one defineView contract as a strictly decoded assistant-ui data UI.
 *
 * Unknown or version-mismatched browser data never reaches the application
 * renderer. It renders the configured fallback, or nothing when omitted.
 */
export const makeAssistantView = <View extends ViewDefinitionContract>(
  view: View,
  config: AssistantViewConfig<View>,
): AssistantDataUI => {
  const Renderer = (props: AssistantDataMessagePartProps) => {
    const data = Schema.decodeUnknownResult(JsonValueSchema)(props.data)
    if (Result.isFailure(data)) {
      return config.fallback === undefined
        ? null
        : createElement(config.fallback, props)
    }

    const decoded = view.decodeResult({
      type: "data",
      name: view.name,
      data: data.success,
    })
    if (Result.isFailure(decoded)) {
      return config.fallback === undefined
        ? null
        : createElement(config.fallback, props)
    }

    return createElement(config.render, {
      ...props,
      data: decoded.success.data,
    })
  }

  return makeAssistantDataUI<unknown>({
    name: view.name,
    render: Renderer,
  })
}

/** assistant-ui metadata key carrying the latest opaque session reference. */
export const assistantChatSessionMetadataKey =
  "popcomputerStructuredChatSession" as const

/** Small fetch capability required by the assistant-ui chat adapter. */
export type AssistantChatFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>

/** Browser dependencies for one structured assistant-ui endpoint. */
export interface AssistantChatModelAdapterOptions {
  readonly endpoint: string
  readonly fetch?: AssistantChatFetch
  /**
   * Receive the complete public-answer snapshot after a strictly decoded
   * persisted response. Supplying this callback does not select debug mode.
   */
  readonly onAnswerSnapshot?: (
    update: UserAnswerUpdate,
  ) => void | Promise<void>
  /**
   * Select the explicit debug response contract and receive its safe state
   * projection after every successful turn. Observer failures are ignored so
   * they cannot change the outcome of an already-persisted chat turn.
   */
  readonly onDebugSnapshot?: (
    snapshot: StructuredChatDebugSnapshot,
  ) => void | Promise<void>
  /**
   * Receive the current state together with the ordered literal model trace.
   * Supplying this callback selects the explicit debug response contract.
   */
  readonly onDebugTurn?: (
    turn: StructuredChatDebugTurn,
  ) => void | Promise<void>
}

const notifyObserver = <Value,>(
  callback: (value: Value) => void | Promise<void>,
  value: Value,
): void => {
  try {
    const notified = callback(value)
    void Promise.resolve(notified).catch(() => undefined)
  } catch {
    // Browser observers are deliberately isolated from the persisted turn.
  }
}

const isAbortError = (cause: unknown): cause is DOMException =>
  cause instanceof DOMException && cause.name === "AbortError"

/** Minimum assistant message shape consumed by the browser adapter. */
export interface AssistantChatThreadMessage {
  readonly role: string
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: string }
  >
  readonly attachments?: ReadonlyArray<unknown>
  readonly metadata: {
    readonly custom: {
      readonly [assistantChatSessionMetadataKey]?: unknown
    }
  }
}

/** Assistant runtime input consumed without importing its nominal types. */
export interface AssistantChatModelRunInput {
  readonly messages: ReadonlyArray<AssistantChatThreadMessage>
  readonly abortSignal: AbortSignal
}

/** Structural chat adapter that remains compatible across peer installations. */
export interface AssistantChatModelAdapter {
  readonly run: (input: AssistantChatModelRunInput) => Promise<{
    readonly content: StructuredChatAssistantMessage["content"]
    readonly metadata: {
      readonly custom:
        | Readonly<Record<never, never>>
        | {
            readonly [assistantChatSessionMetadataKey]:
              StructuredChatSessionReference
          }
    }
  }>
}

const readMessageText = (message: AssistantChatThreadMessage): string =>
  message.content
    .flatMap((part) =>
      part.type === "text" && "text" in part ? [part.text] : [],
    )
    .join("\n")
    .trim()

export const readLatestAssistantChatSession = (
  messages: ReadonlyArray<AssistantChatThreadMessage>,
): Schema.Schema.Type<
  typeof StructuredChatTurnRequestSchema
>["session"] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant") {
      continue
    }
    const session = Schema.decodeUnknownExit(
      StructuredChatSessionReferenceSchema,
    )(message.metadata.custom[assistantChatSessionMetadataKey])
    if (Exit.isSuccess(session)) {
      return session.value
    }
  }

  return undefined
}

const readTurnRequest = (
  messages: ReadonlyArray<AssistantChatThreadMessage>,
) => {
  const message = messages.at(-1)
  if (message?.role !== "user") {
    throw new Error("A user message is required")
  }
  if ((message.attachments?.length ?? 0) > 0) {
    throw new Error("Attachments are not supported")
  }

  return Schema.decodeSync(StructuredChatTurnRequestSchema)({
    session: readLatestAssistantChatSession(messages),
    message: readMessageText(message),
  })
}

/**
 * Adapt assistant-ui to one server-owned structured chat endpoint.
 *
 * By default, only the latest text and opaque prior revision cross the browser
 * boundary. `onAnswerSnapshot` observes the normal persisted response without
 * selecting debug mode. Supplying either debug observer explicitly selects the
 * separate debug response contract.
 */
export const makeAssistantChatModelAdapter = (
  options: AssistantChatModelAdapterOptions,
): AssistantChatModelAdapter => {
  const fetch_ =
    options.fetch ??
    ((input: string, init: RequestInit) =>
      globalThis.fetch(input, init))
  const onAnswerSnapshot = options.onAnswerSnapshot
  const onDebugSnapshot = options.onDebugSnapshot
  const onDebugTurn = options.onDebugTurn
  const debugRequested =
    onDebugSnapshot !== undefined || onDebugTurn !== undefined

  return {
    run: async ({ messages, abortSignal }) => {
      const request = readTurnRequest(messages)
      const response = await fetch_(options.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: abortSignal,
      })
      if (!response.ok && !debugRequested) {
        throw new Error("Structured chat is temporarily unavailable")
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (cause: unknown) {
        abortSignal.throwIfAborted()
        if (isAbortError(cause)) {
          throw cause
        }
        throw new Error(
          response.ok
            ? "Structured chat returned an invalid response"
            : "Structured chat is temporarily unavailable",
        )
      }
      let value: StructuredChatTurnResponse
      if (!debugRequested) {
        const decoded = Schema.decodeUnknownExit(
          StructuredChatTurnResponseSchema,
        )(body, { onExcessProperty: "error" })
        if (Exit.isFailure(decoded)) {
          throw new Error("Structured chat returned an invalid response")
        }
        abortSignal.throwIfAborted()
        if (
          "answers" in decoded.value &&
          onAnswerSnapshot !== undefined
        ) {
          notifyObserver(onAnswerSnapshot, {
            session: decoded.value.session,
            snapshot: decoded.value.answers,
          })
        }
        value = decoded.value
      } else {
        const { StructuredChatDebugTurnResponseSchema } = await import(
          "../core/debug-protocol.js"
        )
        const decoded = Schema.decodeUnknownExit(
          StructuredChatDebugTurnResponseSchema,
        )(body, { onExcessProperty: "error" })
        if (Exit.isFailure(decoded)) {
          throw new Error(
            response.ok
              ? "Structured chat returned an invalid response"
            : "Structured chat is temporarily unavailable",
          )
        }
        abortSignal.throwIfAborted()
        if (decoded.value.outcome === "failure") {
          if (onDebugTurn !== undefined) {
            notifyObserver(onDebugTurn, {
              _tag: "Failed",
              session: decoded.value.session,
              trace: decoded.value.trace,
            })
          }
          throw new Error("Structured chat is temporarily unavailable")
        }
        if (!response.ok) {
          throw new Error("Structured chat is temporarily unavailable")
        }
        if (onAnswerSnapshot !== undefined) {
          notifyObserver(onAnswerSnapshot, {
            session: decoded.value.session,
            snapshot: decoded.value.answers,
          })
        }
        if (onDebugSnapshot !== undefined) {
          notifyObserver(onDebugSnapshot, decoded.value.debug)
        }
        if (onDebugTurn !== undefined) {
          notifyObserver(onDebugTurn, {
            _tag: "Succeeded",
            session: decoded.value.session,
            snapshot: decoded.value.debug,
            trace: decoded.value.trace,
          })
        }
        value = decoded.value
      }

      return {
        content: value.message.content,
        metadata: {
          custom:
            value.session === undefined
              ? {}
              : {
                  [assistantChatSessionMetadataKey]:
                    value.session,
                },
        },
      }
    },
  }
}

/** Safe reason an assistant exploration did not produce a response. */
export const AssistantExplorationClientErrorReasonSchema = Schema.Literals([
  "cancelled",
  "request_failed",
  "invalid_response",
])

/** A browser exploration ended without exposing upstream details. */
export class AssistantExplorationClientError extends Schema.TaggedError<AssistantExplorationClientError>()(
  "AssistantExplorationClientError",
  { reason: AssistantExplorationClientErrorReasonSchema },
) {}

/** Typed outcome of one browser exploration request. */
export type AssistantExplorationClientResult = Result.Result<
  StructuredChatExplorationResponse,
  AssistantExplorationClientError
>

/** Browser dependencies for one structured exploration endpoint. */
export interface AssistantExplorationClientOptions {
  readonly endpoint: string
  readonly fetch?: AssistantChatFetch
}

/** Input retaining the full assistant-held session reference for callers. */
export interface AssistantExplorationClientRunInput {
  readonly session: StructuredChatSessionReference
  readonly call: StructuredChatExplorationRequest["call"]
}

/** Final invocation options kept separate from semantic request input. */
export interface AssistantExplorationClientRunOptions {
  readonly signal?: AbortSignal
}

/** Small browser client for non-progressing conversation explorations. */
export interface AssistantExplorationClient {
  /** Run one exploration with every expected outcome in the returned result. */
  readonly run: (
    input: AssistantExplorationClientRunInput,
    options?: AssistantExplorationClientRunOptions,
  ) => Promise<AssistantExplorationClientResult>
}

/** Create a strict client for one structured exploration endpoint. */
export const makeAssistantExplorationClient = (
  options: AssistantExplorationClientOptions,
): AssistantExplorationClient => {
  const fetch_ =
    options.fetch ??
    ((input: string, init: RequestInit) =>
      globalThis.fetch(input, init))

  return {
    run: async (input, runOptions = {}) => {
      const request = Schema.decodeSync(
        StructuredChatExplorationRequestSchema,
      )({
        session: { id: input.session.id },
        call: input.call,
      }, { onExcessProperty: "error" })

      const failure = (
        reason: Schema.Schema.Type<
          typeof AssistantExplorationClientErrorReasonSchema
        >,
      ) =>
        Result.fail(new AssistantExplorationClientError({ reason }))
      const wasCancelled = () => runOptions.signal?.aborted === true

      let response: Response
      try {
        const requestInit: RequestInit = {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        }
        if (runOptions.signal !== undefined) {
          requestInit.signal = runOptions.signal
        }
        response = await fetch_(options.endpoint, requestInit)
      } catch {
        if (wasCancelled()) {
          return failure("cancelled")
        }
        return failure("request_failed")
      }
      if (wasCancelled()) {
        return failure("cancelled")
      }
      if (!response.ok) {
        return failure("request_failed")
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        if (wasCancelled()) {
          return failure("cancelled")
        }
        return failure("invalid_response")
      }
      if (wasCancelled()) {
        return failure("cancelled")
      }
      const decoded = Schema.decodeUnknownExit(
        StructuredChatExplorationResponseSchema,
      )(body, { onExcessProperty: "error" })
      if (Exit.isFailure(decoded)) {
        return failure("invalid_response")
      }

      return Result.succeed(decoded.value)
    },
  }
}
