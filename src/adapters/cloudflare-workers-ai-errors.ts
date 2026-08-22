import { Schema } from "effect"
import type { ChatModelUnavailableReasonSchema } from "../core/model.js"

/** Safe reason that a configured chat model could not complete a step. */
type ChatModelUnavailableReason = Schema.Schema.Type<
  typeof ChatModelUnavailableReasonSchema
>

/** Maximum number of linked causes examined when walking a failure chain. */
const maximumCauseDepth = 4

const blockedCodePattern = /\b2017\b/

const blockedMessagePattern =
  /response blocked due to security configurations/i

/**
 * Documented Workers AI error codes considered safe enough to extract from
 * error messages.
 */
const documentedCodePattern =
  /(?:"code"\s*:\s*|\bcode\s*[=:]\s*)(2017|3003|3006|3007|3008|3023|3036|3039|3040|3041|3042|5004|5005|5007|5016|5018|5019|5035|8007)\b/i

/** Documented Workers AI error codes safe to expose as telemetry. */
const documentedCodes = new Set([
  "2017",
  "3003",
  "3006",
  "3007",
  "3008",
  "3023",
  "3036",
  "3039",
  "3040",
  "3041",
  "3042",
  "5004",
  "5005",
  "5007",
  "5016",
  "5018",
  "5019",
  "5035",
  "8007",
])

/**
 * Any object that may carry a Workers AI-style error code or expose one
 * more linked cause.
 */
const CauseCarrierSchema = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
})

const isCauseCarrier = Schema.is(CauseCarrierSchema)

/** Any failure value carrying the Workers AI response-blocking status code. */
const BlockedCodeSchema = Schema.Struct({
  code: Schema.Literals([2017, "2017"]),
})

const carriesBlockedCode = Schema.is(BlockedCodeSchema)

/** Provider code fields may be strings or numbers before classification. */
const isCodeValue = Schema.is(
  Schema.Union([Schema.String, Schema.Number]),
)

const indicatesBlockedResponse = (cause: unknown): boolean =>
  carriesBlockedCode(cause) ||
  (cause instanceof Error &&
    blockedCodePattern.test(cause.message) &&
    blockedMessagePattern.test(cause.message))

const parseDocumentedErrorCode = (
  code: string | number,
): string | undefined =>
  documentedCodes.has(String(code)) ? String(code) : undefined

/**
 * Classify an unknown Cloudflare Workers AI failure cause.
 *
 * Walks the `cause` chain up to four links deep with a seen-set so cyclic
 * chains terminate. The result is blocked when some cause carries
 * `code === 2017` (number or string form) or is an `Error` whose message
 * matches `\b2017\b` together with the documented security-configurations
 * phrase; every other failure classifies as a request failure.
 */
export const cloudflareWorkersAiClassifyError = (
  cause: unknown,
): ChatModelUnavailableReason => {
  const visited = new Set<object>()
  let candidate: unknown = cause
  for (let depth = 0; depth < maximumCauseDepth; depth += 1) {
    if (indicatesBlockedResponse(candidate)) {
      return "response_blocked"
    }
    if (!isCauseCarrier(candidate)) {
      break
    }
    if (visited.has(candidate)) {
      break
    }
    visited.add(candidate)
    candidate = candidate.cause
  }
  return "request_failed"
}

/**
 * Extract a documented Workers AI error code for safe telemetry, if present.
 *
 * Accepts only the documented numeric allowlist, whether read from a `code`
 * property or extracted from an `Error` message. Unknown values are never
 * forwarded as telemetry. Cause-chain traversal is cycle-safe and examines
 * at most four links.
 */
export const cloudflareWorkersAiErrorCode = (
  cause: unknown,
): string | undefined => {
  const visited = new Set<object>()
  let candidate: unknown = cause
  for (let depth = 0; depth < maximumCauseDepth; depth += 1) {
    if (!isCauseCarrier(candidate)) {
      return undefined
    }
    const codeField = candidate.code
    if (codeField !== undefined && isCodeValue(codeField)) {
      const directCode = parseDocumentedErrorCode(codeField)
      if (directCode !== undefined) {
        return directCode
      }
    }
    if (candidate instanceof Error) {
      const documentedCode =
        documentedCodePattern.exec(candidate.message)?.[1]
      if (documentedCode !== undefined) {
        return documentedCode
      }
    }
    if (visited.has(candidate)) {
      return undefined
    }
    visited.add(candidate)
    candidate = candidate.cause
  }
  return undefined
}
