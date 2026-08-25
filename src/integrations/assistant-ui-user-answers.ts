import { useSyncExternalStore } from "react"
import type { StructuredChatSessionReference } from "../core/protocol.js"
import type { StructuredChatUserAnswerSnapshot } from "../core/user-answer-projection.js"

/** One complete public-answer snapshot correlated with its persisted revision. */
export interface StructuredChatUserAnswerUpdate {
  readonly session: StructuredChatSessionReference
  readonly snapshot: StructuredChatUserAnswerSnapshot
}

/** Explicit latest-value source consumed by application answer-form UIs. */
export interface StructuredChatUserAnswerStore {
  /** Atomically replace the current session-and-snapshot update. */
  readonly receive: (update: StructuredChatUserAnswerUpdate) => void
  /** Discard the retained update and notify active subscribers. */
  readonly clear: () => void
  /** Subscribe to complete update replacement. */
  readonly subscribe: (listener: () => void) => () => void
  /** Read the latest update, or null before the first persisted response. */
  readonly getSnapshot: () => StructuredChatUserAnswerUpdate | null
}

/** Create one isolated latest-value store for public answer snapshots. */
export const createStructuredChatUserAnswerStore =
  (): StructuredChatUserAnswerStore => {
    let current: StructuredChatUserAnswerUpdate | null = null
    const listeners = new Set<() => void>()

    const notify = (): void => {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // One faulty UI consumer must not leave later subscribers stale.
        }
      }
    }

    return {
      receive: (update) => {
        if (Object.is(update, current)) {
          return
        }
        current = update
        notify()
      },
      clear: () => {
        if (current === null) {
          return
        }
        current = null
        notify()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getSnapshot: () => current,
    }
  }

/** Subscribe one React consumer to complete public-answer replacements. */
export const useStructuredChatUserAnswers = (
  store: StructuredChatUserAnswerStore,
): StructuredChatUserAnswerUpdate | null =>
  useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
