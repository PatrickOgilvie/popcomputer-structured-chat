import { Schema } from "effect"
import type { StructuredChatDebugSnapshot } from "../core/debug.js"
import type { StructuredChatDebugTurn } from "../core/debug-protocol.js"

/** Explicit in-memory source consumed by one structured-chat debug panel. */
export interface StructuredChatDebugStore {
  /** Replace the current snapshot and notify active subscribers. */
  readonly receive: (snapshot: StructuredChatDebugSnapshot) => void
  /** Add one atomic state-and-trace update from a debug turn response. */
  readonly receiveTurn: (turn: StructuredChatDebugTurn) => void
  /** Immediately discard snapshots and sensitive literal trace data. */
  readonly clear: () => void
  /** Subscribe to snapshot or trace-history replacement. */
  readonly subscribe: (listener: () => void) => () => void
  /** Read the current snapshot, or null before the first reply. */
  readonly getSnapshot: () => StructuredChatDebugSnapshot | null
  /** Read the stable combined state consumed by the package debug panel. */
  readonly getView: () => StructuredChatDebugStoreView
}

/** Current debug state and every captured trace for its browser session. */
export interface StructuredChatDebugStoreView {
  readonly snapshot: StructuredChatDebugSnapshot | null
  readonly turns: ReadonlyArray<StructuredChatDebugTurn>
}

const StructuredChatDebugStoreOptionsSchema = Schema.Struct({
  maximumTurns: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 200 }),
    ),
  ),
})

/** Retention policy for one in-memory structured-chat debug store. */
export interface StructuredChatDebugStoreOptions {
  readonly maximumTurns?: number
}

/** Create one isolated, bounded structured-chat debug snapshot store. */
export const createStructuredChatDebugStore = (
  options: StructuredChatDebugStoreOptions = {},
): StructuredChatDebugStore => {
  const { maximumTurns = 100 } = Schema.decodeSync(
    StructuredChatDebugStoreOptionsSchema,
  )(options, { onExcessProperty: "error" })
  let current: StructuredChatDebugSnapshot | null = null
  let turns: ReadonlyArray<StructuredChatDebugTurn> = []
  let view: StructuredChatDebugStoreView = { snapshot: current, turns }
  const listeners = new Set<() => void>()

  const notify = (): void => {
    view = { snapshot: current, turns }
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // One faulty preview consumer must not leave later panels stale.
      }
    }
  }

  return {
    receive: (snapshot) => {
      if (Object.is(snapshot, current)) {
        return
      }
      current = snapshot
      notify()
    },
    receiveTurn: (turn) => {
      let currentSessionId: string | undefined
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const existingSession = turns[index]?.session
        if (existingSession !== undefined && existingSession !== null) {
          currentSessionId = existingSession.id
          break
        }
      }
      const incomingSessionId = turn.session?.id
      if (
        currentSessionId !== undefined &&
        incomingSessionId !== undefined &&
        currentSessionId !== incomingSessionId
      ) {
        turns = []
        current = null
      }
      const existingIndex =
        turn._tag === "Succeeded"
          ? turns.findIndex(
              (existing) =>
                existing._tag === "Succeeded" &&
                existing.session.revision === turn.session.revision,
            )
          : -1
      const nextTurns =
        existingIndex === -1
          ? [...turns, turn]
          : turns.map((existing, index) =>
              index === existingIndex ? turn : existing,
            )
      turns =
        nextTurns.length > maximumTurns
          ? nextTurns.slice(-maximumTurns)
          : nextTurns
      if (turn._tag === "Succeeded") {
        current = turn.snapshot
      }
      notify()
    },
    clear: () => {
      if (current === null && turns.length === 0) {
        return
      }
      current = null
      turns = []
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => current,
    getView: () => view,
  }
}
