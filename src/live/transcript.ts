import { Context, Effect, Option, Schema } from "effect"
import {
  ControlledTurnInputSchema,
  type ControlledTurnInput,
} from "../core/observed-turn.js"
import type { Fragment } from "./contracts.js"
import { Id, InvalidAction } from "./contracts.js"

/** A revisable, exact-text candidate ending at an observed user fragment. */
export interface Candidate {
  readonly throughEventId: string
  readonly fragments: ReadonlyArray<Fragment>
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant"
    readonly content: string
  }>
}

/** Context available to application-owned readiness and supersession policy. */
export interface DecisionContext {
  readonly delegation: { readonly id: string; readonly offsetMs: number }
  readonly transcript: ReadonlyArray<Fragment>
  readonly candidate: Option.Option<Candidate>
  readonly active: Option.Option<{
    readonly delegationId: string
    readonly commandAdmitted: boolean
    readonly committed: boolean
    readonly superseded: boolean
  }>
}

/** @internal Scoped context for an ordinary Effect readiness program. */
export class DecisionScope extends Context.Service<
  DecisionScope,
  DecisionContext
>()("@popcomputer/structured-chat/live/DecisionScope") {}

/** Read original transcript evidence and the current execution status. */
export const context: Effect.Effect<DecisionContext, never, DecisionScope> =
  Effect.gen(function* () {
    return yield* DecisionScope
  })

/** Explicit application decisions; no silence timer or delegation implies Ready. */
export const Decision = Schema.TaggedUnion({
  Await: {},
  Ready: { throughEventId: Id },
  Supersede: { delegationId: Id },
  Clarify: {
    speech: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(50_000),
    ),
  },
})

/** Decision produced by the application's readiness policy. */
export type Decision = typeof Decision.Type

/** Keep the delegation pending until further evidence or application context is available. */
export const awaitContext: Decision = Decision.cases.Await.make({})

/** Accept exactly the candidate the application inspected, not future transcript fragments. */
export const ready = (candidate: Candidate): Decision =>
  Decision.cases.Ready.make({
    throughEventId: candidate.throughEventId,
  })

/** Cooperatively invalidate one earlier intent without claiming to undo admitted commands. */
export const supersede = (delegationId: string): Decision =>
  Decision.cases.Supersede.make({
    delegationId,
  })

const group = (fragments: ReadonlyArray<Fragment>): Candidate["messages"] => {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = []

  for (const fragment of fragments) {
    const last = messages.at(-1)

    if (last?.role === fragment.role) last.content += fragment.delta
    else messages.push({ role: fragment.role, content: fragment.delta })
  }

  return messages
    .map(({ role, content }) => ({ role, content: content.trim() }))
    .filter(({ content }) => content.length > 0)
}

/** @internal Assemble a candidate without inventing whitespace, quotes, or turn completion. */
export const candidate = (
  fragments: ReadonlyArray<Fragment>,
  consumed: number,
): Option.Option<Candidate> => {
  const pending = fragments.slice(consumed)
  let lastUser = -1

  for (let index = 0; index < pending.length; index += 1) {
    const fragment = pending[index]

    if (fragment?.role === "user" && fragment.delta.trim().length > 0)
      lastUser = index
  }

  if (lastUser < 0) return Option.none()
  const selected = pending.slice(0, lastUser + 1)
  const through = selected.at(-1)

  if (through === undefined) return Option.none()

  return Option.some({
    throughEventId: through.eventId,
    fragments: selected,
    messages: group(selected),
  })
}

/** @internal Freeze original source fragments into stable, provider-neutral observations. */
export const freeze = (
  fragments: ReadonlyArray<Fragment>,
  consumed: number,
  throughEventId: string,
  identity: string,
  delegationIndex: number,
): Effect.Effect<
  {
    readonly turn: Extract<
      ControlledTurnInput["turn"],
      { readonly _tag: "Observed" }
    >
    readonly through: number
  },
  InvalidAction
> => {
  const end = fragments.findIndex(({ eventId }) => eventId === throughEventId)

  if (end < consumed || fragments[end]?.role !== "user")
    return Effect.fail(new InvalidAction({ reason: "stale_candidate" }))
  const selected = fragments.slice(consumed, end + 1)
  const messages = group(selected)

  if (
    messages.length > 199 ||
    messages.some(({ content }) => content.length > 50_000)
  )
    return Effect.fail(new InvalidAction({ reason: "history_limit" }))

  if (messages.at(-1)?.role !== "user")
    return Effect.fail(new InvalidAction({ reason: "missing_candidate" }))

  return Effect.succeed({
    turn: ControlledTurnInputSchema.fields.turn.cases.Observed.make({
      batchId: `${identity}.batch.${delegationIndex}`,
      messages: messages.map((message, index) => ({
        ...message,
        id: `${identity}.fragment.${consumed}.${index}`,
      })),
    }),
    through: end + 1,
  })
}
