import { Predicate, Effect, Option, Schema } from "effect"
import { ChatSessionRevisionSchema } from "../core/session.js"
import {
  ControlledTurnInputSchema,
  type ControlledTurnInput,
} from "../core/observed-turn.js"
import { TurnSuperseded } from "../core/turn-control.js"
import type { CommandId } from "../core/command.js"
import {
  Binding,
  ConnectionFailure,
  Fragment,
  Id,
  InvalidAction,
  Presentation,
  RecoveryRequired,
  type Commentary,
  type Event,
  Publication,
} from "./contracts.js"
import { candidate, freeze, type DecisionContext } from "./transcript.js"

const maximumFragments = 2_000

const maximumTranscriptCharacters = 200_000

const maximumDelegations = 200

const Revision = Schema.NullOr(ChatSessionRevisionSchema)

const WorkflowOutcome = Schema.TaggedUnion({
  NotAdvanced: {},
  Committed: {
    revision: ChatSessionRevisionSchema,
    commandId: Schema.NullOr(Schema.String),
  },
})

const Phase = Schema.TaggedUnion({
  Waiting: {},
  Running: {
    input: ControlledTurnInputSchema,
    through: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    commandId: Schema.NullOr(Schema.String),
    commit: Schema.Literals(["NotStarted", "Pending"]),
  },
  Committed: {
    revision: ChatSessionRevisionSchema,
    commandId: Schema.NullOr(Schema.String),
  },
  Prepared: { deliveryId: Id, workflow: WorkflowOutcome },
  Superseded: {},
})

const Delegation = Schema.Struct({
  id: Id,
  eventId: Id,
  offsetMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  intent: Schema.Literals(["Current", "Superseded"]),
  phase: Phase,
})

/** @internal One delegation's conversational intent and independent workflow progress. */
export interface Delegation extends Schema.Schema.Type<typeof Delegation> {}

const Delivery = Schema.Struct({
  id: Id,
  delegationId: Id,
  presentation: Presentation,
  voice: Schema.Literals([
    "Prepared",
    "Attempted",
    "Accepted",
    "Unknown",
    "Rejected",
    "Suppressed",
  ]),
  browser: Schema.Literals(["Prepared", "Published"]),
})

/** @internal Prepared output with independent voice and application delivery progress. */
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

/** @internal Canonical session facts, reconstructed at the journal persistence boundary. */
export const State = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  binding: Binding,
  lifecycle: Schema.Literals(["Running", "Closing", "Closed", "Interrupted"]),
  provider: Schema.Literals(["Open", "CloseRequested", "Finalized"]),
  chatRevision: Revision,
  fragments: Schema.Array(Fragment).check(Schema.isMaxLength(maximumFragments)),
  consumed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delegations: Schema.Array(Delegation).check(
    Schema.isMaxLength(maximumDelegations),
  ),
  deliveries: Schema.Array(Delivery).check(
    Schema.isMaxLength(maximumDelegations),
  ),
  usageSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter(
    (state) =>
      state.consumed <= state.fragments.length &&
      new Set(state.fragments.map(({ eventId }) => eventId)).size ===
        state.fragments.length &&
      new Set(state.delegations.map(({ id }) => id)).size ===
        state.delegations.length &&
      new Set(state.deliveries.map(({ id }) => id)).size ===
        state.deliveries.length &&
      new Set(state.deliveries.map(({ delegationId }) => delegationId)).size ===
        state.deliveries.length &&
      state.delegations.filter(
        ({ phase }) =>
          Predicate.isTagged(phase, "Running") ||
          Predicate.isTagged(phase, "Committed"),
      ).length <= 1 &&
      state.fragments.reduce((length, { delta }) => length + delta.length, 0) <=
        maximumTranscriptCharacters &&
      (state.consumed === 0 || state.chatRevision !== null) &&
      state.delegations.every(({ id, phase }) =>
        Phase.match(phase, {
          Running: (phase) =>
            phase.through > state.consumed &&
            phase.through <= state.fragments.length &&
            Predicate.isTagged(phase.input.turn, "Observed") &&
            phase.input.namespace === state.binding.namespace &&
            phase.input.sessionId === state.binding.sessionId &&
            (phase.input.expectedRevision ?? null) === state.chatRevision,
          Committed: (phase) => phase.revision === state.chatRevision,
          Prepared: (phase) =>
            state.deliveries.some(
              (delivery) =>
                delivery.id === phase.deliveryId &&
                delivery.delegationId === id,
            ),
          Waiting: () => true,
          Superseded: () => true,
        }),
      ) &&
      state.deliveries.every((delivery) =>
        state.delegations.some(
          ({ id, phase }) =>
            id === delivery.delegationId &&
            Predicate.isTagged(phase, "Prepared") &&
            phase.deliveryId === delivery.id,
        ),
      ) &&
      (state.lifecycle !== "Running" || state.provider === "Open") &&
      (state.lifecycle !== "Closed" ||
        (state.provider === "Finalized" &&
          state.delegations.every(
            ({ phase }) =>
              Predicate.isTagged(phase, "Prepared") ||
              Predicate.isTagged(phase, "Superseded"),
          ) &&
          state.deliveries.every(({ voice }) => voice !== "Attempted"))),
  ),
)

/** @internal Fully decoded immutable session state. */
export interface State extends Schema.Schema.Type<typeof State> {}

/** @internal A decision and its next state; persist state before using the returned value. */
export interface Transition<A = void> {
  readonly state: State
  readonly value: A
}

type Notice = Extract<Publication, { readonly _tag: "Notice" }>

/** @internal Provider ingestion consequences; duplicate evidence does not invalidate policy. */
export interface Ingestion {
  readonly reassess: boolean
  readonly notice: Option.Option<Notice>
}

const transition = (state: State): Transition => ({ state, value: undefined })

const invalidState = () => new InvalidAction({ reason: "invalid_state" })

const replaceDelegation = (state: State, delegation: Delegation): State => ({
  ...state,
  delegations: state.delegations.map((entry) =>
    entry.id === delegation.id ? delegation : entry,
  ),
})

const replaceDelivery = (state: State, delivery: Delivery): State => ({
  ...state,
  deliveries: state.deliveries.map((entry) =>
    entry.id === delivery.id ? delivery : entry,
  ),
})

const delegationFor = (
  state: State,
  id: string,
): Effect.Effect<Delegation, InvalidAction> => {
  const delegation = state.delegations.find((entry) => entry.id === id)

  return delegation === undefined
    ? Effect.fail(invalidState())
    : Effect.succeed(delegation)
}

const deliveryFor = (
  state: State,
  id: string,
): Effect.Effect<Delivery, InvalidAction> => {
  const delivery = state.deliveries.find((entry) => entry.id === id)

  return delivery === undefined
    ? Effect.fail(invalidState())
    : Effect.succeed(delivery)
}

/** @internal Construct an empty session from its authorized binding and current workflow revision. */
export const initial = (
  binding: Binding,
  chatRevision: string | null,
): State => ({
  schemaVersion: 1,
  binding,
  lifecycle: "Running",
  provider: "Open",
  chatRevision,
  fragments: [],
  consumed: 0,
  delegations: [],
  deliveries: [],
  usageSeconds: 0,
})

const progress = (delegation: Delegation) => {
  const { phase } = delegation

  const workflow = Predicate.isTagged(phase, "Committed")
    ? phase
    : Predicate.isTagged(phase, "Prepared")
      ? phase.workflow
      : WorkflowOutcome.cases.NotAdvanced.make({})

  return {
    delegationId: delegation.id,
    commandAdmitted: Predicate.isTagged(phase, "Running")
      ? phase.commandId !== null
      : Predicate.isTagged(workflow, "Committed") &&
        workflow.commandId !== null,
    committed: Predicate.isTagged(workflow, "Committed"),
    superseded: delegation.intent === "Superseded",
  }
}

/** @internal Project the next policy context without leaking phase interpretation to the scheduler. */
export const context = (
  state: State,
  activeId: string | undefined,
): Option.Option<DecisionContext> => {
  const active =
    activeId === undefined
      ? undefined
      : state.delegations.find(({ id }) => id === activeId)

  if (activeId !== undefined && active === undefined)
    throw new Error("Active worker lost its delegation")

  const target =
    active ??
    state.delegations.find(({ phase }) => Predicate.isTagged(phase, "Waiting"))

  if (target === undefined) return Option.none()

  return Option.some({
    delegation: { id: target.id, offsetMs: target.offsetMs },
    transcript: state.fragments,
    candidate: candidate(state.fragments, state.consumed),
    active:
      active === undefined ? Option.none() : Option.some(progress(active)),
  })
}

/** @internal Retain provider evidence and derive any required delivery notification. */
export const observe = (
  state: State,
  event: Event,
): Effect.Effect<Transition<Ingestion>, InvalidAction | ConnectionFailure> => {
  const result = (
    next: State,
    reassess = false,
    notice: Option.Option<Notice> = Option.none(),
  ) => Effect.succeed({ state: next, value: { reassess, notice } })

  switch (event._tag) {
    case "Transcript": {
      const fragment = event.fragment

      const previous = state.fragments.find(
        ({ eventId }) => eventId === fragment.eventId,
      )

      if (previous !== undefined)
        return previous.role === fragment.role &&
          previous.delta === fragment.delta &&
          previous.startMs === fragment.startMs &&
          previous.endMs === fragment.endMs
          ? result(state)
          : Effect.fail(new InvalidAction({ reason: "identity_conflict" }))

      if (
        state.fragments.length >= maximumFragments ||
        state.fragments.reduce(
          (length, { delta }) => length + delta.length,
          fragment.delta.length,
        ) > maximumTranscriptCharacters
      )
        return Effect.fail(new InvalidAction({ reason: "history_limit" }))

      return result(
        { ...state, fragments: [...state.fragments, fragment] },
        true,
      )
    }

    case "Delegated": {
      const previous = state.delegations.find(
        ({ id }) => id === event.delegationId,
      )

      if (previous !== undefined)
        return previous.offsetMs === event.offsetMs &&
          previous.eventId === event.eventId
          ? result(state)
          : Effect.fail(new InvalidAction({ reason: "identity_conflict" }))

      if (state.delegations.length >= maximumDelegations)
        return Effect.fail(new InvalidAction({ reason: "history_limit" }))

      return result(
        {
          ...state,
          delegations: [
            ...state.delegations,
            {
              id: event.delegationId,
              eventId: event.eventId,
              offsetMs: event.offsetMs,
              intent: "Current",
              phase: Phase.cases.Waiting.make({}),
            },
          ],
        },
        true,
      )
    }

    case "Accepted":
    case "Rejected": {
      if (event.clientEventId === null)
        return Effect.fail(
          new ConnectionFailure({ reason: "provider_rejected" }),
        )

      const delivery = state.deliveries.find(
        ({ id }) => id === event.clientEventId,
      )

      if (
        delivery === undefined ||
        (delivery.voice !== "Attempted" && delivery.voice !== "Unknown")
      )
        return result(state)

      return result(
        replaceDelivery(state, { ...delivery, voice: event._tag }),
        false,
        Predicate.isTagged(event, "Rejected")
          ? Option.some(
              Publication.Notice({
                id: `${delivery.id}.rejected`,
                reason: "delivery_rejected",
              }),
            )
          : Option.none(),
      )
    }

    case "Usage":
      return result(
        event.seconds <= state.usageSeconds
          ? state
          : { ...state, usageSeconds: event.seconds },
      )
    case "Closed":
      return result(
        {
          ...state,
          lifecycle: "Closing",
          provider: "Finalized",
          usageSeconds: Math.max(state.usageSeconds, event.seconds),
        },
        true,
      )
  }
}

/** @internal Freeze and claim one waiting delegation under the current workflow revision. */
export const claim = (
  state: State,
  id: string,
  throughEventId: string,
  identity: string,
): Effect.Effect<Transition<ControlledTurnInput>, InvalidAction> =>
  Effect.gen(function* () {
    const delegation = yield* delegationFor(state, id)

    if (
      state.lifecycle !== "Running" ||
      delegation.intent !== "Current" ||
      !Predicate.isTagged(delegation.phase, "Waiting") ||
      state.delegations.some(
        ({ phase }) =>
          Predicate.isTagged(phase, "Running") ||
          Predicate.isTagged(phase, "Committed"),
      )
    )
      return yield* invalidState()

    const frozen = yield* freeze(
      state.fragments,
      state.consumed,
      throughEventId,
      identity,
      state.delegations.findIndex((entry) => entry.id === id),
    )

    const input: ControlledTurnInput = {
      namespace: state.binding.namespace,
      sessionId: state.binding.sessionId,
      expectedRevision: state.chatRevision ?? undefined,
      turn: frozen.turn,
    }

    return {
      value: input,
      state: replaceDelegation(state, {
        ...delegation,
        phase: Phase.cases.Running.make({
          input,
          through: frozen.through,
          commandId: null,
          commit: "NotStarted",
        }),
      }),
    }
  })

// These capabilities are supplied only to the action owning a running claim.
const running = (state: State, id: string) => {
  const delegation = state.delegations.find((entry) => entry.id === id)

  if (delegation?.phase._tag !== "Running")
    throw new Error("Execution control requires a running delegation")

  return { delegation, phase: delegation.phase }
}

const checkIntent = (
  state: State,
  delegation: Delegation,
): Effect.Effect<void, TurnSuperseded> => {
  if (delegation.intent === "Superseded")
    return Effect.fail(new TurnSuperseded({ reason: "newer_intent" }))

  if (state.lifecycle !== "Running")
    return Effect.fail(new TurnSuperseded({ reason: "session_closing" }))

  return Effect.void
}

/** @internal Refuse work whose intent changed before execution. */
export const check = (
  state: State,
  id: string,
): Effect.Effect<void, TurnSuperseded> =>
  Effect.gen(function* () {
    return yield* checkIntent(state, running(state, id).delegation)
  })

/** @internal Authorize one command; the runtime persists this transition before execution. */
export const admit = (
  state: State,
  id: string,
  commandId: CommandId,
): Effect.Effect<Transition, TurnSuperseded> =>
  Effect.gen(function* () {
    const { delegation, phase } = running(state, id)
    yield* checkIntent(state, delegation)

    if (phase.commandId !== null && phase.commandId !== commandId)
      return yield* Effect.die(
        new Error("Delegation already admitted another command"),
      )

    return transition(
      replaceDelegation(state, {
        ...delegation,
        phase: { ...phase, commandId },
      }),
    )
  })

/** @internal Durably mark the commit window before workflow storage can change. Admitted commands retain permission after supersession. */
export const beforeCommit = (
  state: State,
  id: string,
): Effect.Effect<Transition, TurnSuperseded> =>
  Effect.gen(function* () {
    const { delegation, phase } = running(state, id)

    if (phase.commandId === null) yield* checkIntent(state, delegation)

    return transition(
      replaceDelegation(state, {
        ...delegation,
        phase: { ...phase, commit: "Pending" },
      }),
    )
  })

/** @internal Retain a completed workflow revision and consume only its frozen observations. */
export const commit = (
  state: State,
  id: string,
  revision: string,
): Effect.Effect<Transition, InvalidAction> =>
  Effect.gen(function* () {
    const delegation = yield* delegationFor(state, id)

    if (
      !Predicate.isTagged(delegation.phase, "Running") ||
      delegation.phase.commit !== "Pending"
    )
      return yield* invalidState()

    return transition({
      ...replaceDelegation(state, {
        ...delegation,
        phase: Phase.cases.Committed.make({
          revision,
          commandId: delegation.phase.commandId,
        }),
      }),
      chatRevision: revision,
      consumed: delegation.phase.through,
    })
  })

/** @internal Change conversational intent without erasing admitted or committed work. */
export const supersede = (
  state: State,
  id: string,
): Effect.Effect<Transition<boolean>, InvalidAction> =>
  delegationFor(state, id).pipe(
    Effect.map((delegation) => ({
      state:
        delegation.intent === "Superseded"
          ? state
          : replaceDelegation(state, { ...delegation, intent: "Superseded" }),
      value: delegation.intent !== "Superseded",
    })),
  )

/** @internal Abandon only before command admission and workflow commit; uncertain outcomes require reconciliation. */
export const abandon = (
  state: State,
  id: string,
): Effect.Effect<Transition, InvalidAction | RecoveryRequired> =>
  Effect.gen(function* () {
    const delegation = yield* delegationFor(state, id)

    if (
      !Predicate.isTagged(delegation.phase, "Running") ||
      delegation.phase.commandId !== null ||
      delegation.phase.commit === "Pending"
    )
      return yield* new RecoveryRequired({
        reason: Predicate.isTagged(delegation.phase, "Committed")
          ? "committed_presentation_missing"
          : "backend_outcome_unknown",
      })

    return transition(
      replaceDelegation(state, {
        ...delegation,
        intent: "Superseded",
        phase: Phase.cases.Superseded.make({}),
      }),
    )
  })

/** @internal Prepare output once, retaining whether its action actually advanced the workflow. */
export const prepare = (
  state: State,
  id: string,
  presentation: Presentation,
  identity: string,
): Effect.Effect<Transition<Delivery>, InvalidAction | RecoveryRequired> =>
  Effect.gen(function* () {
    const delegation = yield* delegationFor(state, id)
    const { phase } = delegation

    if (
      Predicate.isTagged(phase, "Prepared") ||
      Predicate.isTagged(phase, "Superseded")
    )
      return yield* invalidState()

    if (
      Predicate.isTagged(phase, "Running") &&
      (phase.commandId !== null || phase.commit === "Pending")
    )
      return yield* new RecoveryRequired({ reason: "backend_outcome_unknown" })

    if (
      presentation.browser !== null &&
      (presentation.browser.session.id !== state.binding.sessionId ||
        presentation.browser.session.revision !== state.chatRevision)
    )
      return yield* invalidState()

    const delivery: Delivery = {
      id: `${identity}.delivery.${state.delegations.findIndex((entry) => entry.id === id)}`,
      delegationId: id,
      presentation,
      voice: "Prepared",
      browser: "Prepared",
    }

    return {
      value: delivery,
      state: {
        ...replaceDelegation(state, {
          ...delegation,
          phase: Phase.cases.Prepared.make({
            deliveryId: delivery.id,
            workflow: Phase.guards.Committed(phase)
              ? phase
              : WorkflowOutcome.cases.NotAdvanced.make({}),
          }),
        }),
        deliveries: [...state.deliveries, delivery],
      },
    }
  })

/** @internal Project a delivery with the latest conversational intent immediately before publication. */
export const publication = (
  state: State,
  delivery: Delivery,
): Effect.Effect<Publication, InvalidAction> =>
  delegationFor(state, delivery.delegationId).pipe(
    Effect.map((delegation) =>
      Publication.Presentation({
        id: delivery.id,
        delegationId: delivery.delegationId,
        presentation: delivery.presentation,
        superseded: delegation.intent === "Superseded",
      }),
    ),
  )

/** @internal Record successful application publication independently of voice delivery. */
export const published = (
  state: State,
  id: string,
): Effect.Effect<Transition, InvalidAction> =>
  deliveryFor(state, id).pipe(
    Effect.map((delivery) =>
      transition(replaceDelivery(state, { ...delivery, browser: "Published" })),
    ),
  )

/** @internal Decide and record a single append attempt before the runtime writes to the provider. */
export const attempt = (
  state: State,
  id: string,
): Effect.Effect<Transition<Option.Option<Commentary>>, InvalidAction> =>
  Effect.gen(function* () {
    const delivery = yield* deliveryFor(state, id)
    const delegation = yield* delegationFor(state, delivery.delegationId)

    if (delivery.voice !== "Prepared" || delivery.browser !== "Published")
      return yield* invalidState()
    const speech = delivery.presentation.speech

    const commentary =
      delegation.intent === "Current" &&
      state.provider !== "Finalized" &&
      speech !== null
        ? Option.some({
            eventId: id,
            delegationId: delegation.id,
            content: speech,
          })
        : Option.none<Commentary>()

    return {
      value: commentary,
      state: replaceDelivery(state, {
        ...delivery,
        voice: Option.isSome(commentary) ? "Attempted" : "Suppressed",
      }),
    }
  })

/** @internal Classify an unresolved write without contradicting provider acknowledgement or repeating notices. */
export const deliveryFailed = (
  state: State,
  id: string,
  outcome: "Rejected" | "Unknown",
): Effect.Effect<Transition<Option.Option<Notice>>, InvalidAction> =>
  deliveryFor(state, id).pipe(
    Effect.map((delivery) =>
      delivery.voice !== "Attempted"
        ? { state, value: Option.none<Notice>() }
        : {
            state: replaceDelivery(state, { ...delivery, voice: outcome }),
            value: Option.some<Notice>(
              Publication.Notice({
                id: `${id}.failure`,
                reason:
                  outcome === "Rejected"
                    ? "delivery_rejected"
                    : "delivery_unknown",
              }),
            ),
          },
    ),
  )

/** @internal Stop admitting new work while active work and publications drain. */
export const stop = (state: State): Effect.Effect<Transition> =>
  Effect.succeed(
    transition(
      state.lifecycle === "Running"
        ? { ...state, lifecycle: "Closing" }
        : state,
    ),
  )

/** @internal Record the close attempt before writing; final usage still requires provider acknowledgement. */
export const requestClose = (
  state: State,
): Effect.Effect<Transition, InvalidAction> => {
  if (state.lifecycle !== "Closing" || state.provider !== "Open")
    return Effect.fail(invalidState())

  return Effect.succeed(transition({ ...state, provider: "CloseRequested" }))
}

const settleAttempts = (
  deliveries: ReadonlyArray<Delivery>,
): ReadonlyArray<Delivery> =>
  deliveries.map((delivery) =>
    delivery.voice === "Attempted"
      ? { ...delivery, voice: "Unknown" }
      : delivery,
  )

/** @internal Finish after the provider and workers drain; unresolved append attempts remain unknown. */
export const finish = (
  state: State,
): Effect.Effect<Transition, InvalidAction> => {
  if (
    state.provider !== "Finalized" ||
    state.delegations.some(
      ({ phase }) =>
        Predicate.isTagged(phase, "Running") ||
        Predicate.isTagged(phase, "Committed"),
    )
  )
    return Effect.fail(invalidState())

  return Effect.succeed(
    transition({
      ...state,
      lifecycle: "Closed",
      delegations: state.delegations.map((delegation) =>
        Predicate.isTagged(delegation.phase, "Waiting")
          ? {
              ...delegation,
              intent: "Superseded",
              phase: Phase.cases.Superseded.make({}),
            }
          : delegation,
      ),
      deliveries: settleAttempts(state.deliveries),
    }),
  )
}

/** @internal Preserve provider finalization and backend progress when the execution owner fails. */
export const interrupt = (state: State): Effect.Effect<Transition> =>
  Effect.succeed(
    transition(
      state.lifecycle === "Closed"
        ? state
        : {
            ...state,
            lifecycle: "Interrupted",
            deliveries: settleAttempts(state.deliveries),
          },
    ),
  )
