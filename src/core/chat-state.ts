import type { RuntimeCollectStageState } from "./answer-collection.js"

/**
 * @internal Runtime-erased persisted chat state, used only after the owning
 * definition's state codec has decoded it.
 */
export interface RuntimeChatState {
  readonly schemaVersion: number
  readonly chat: string
  readonly stage: number
  readonly status: "active" | "complete"
  readonly stages: Readonly<Partial<Record<string, RuntimeCollectStageState>>>
  readonly repair?: {
    readonly pendingStages: ReadonlyArray<number>
  }
}
