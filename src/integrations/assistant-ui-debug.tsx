import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { StructuredChatDebugSnapshot } from "../core/debug.js"

/** Viewport corner used by the structured-chat debug panel. */
export type StructuredChatDebugPanelPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"

/** Color treatment used by the structured-chat debug panel. */
export type StructuredChatDebugPanelTheme = "system" | "light" | "dark"

/** Explicit in-memory source consumed by one structured-chat debug panel. */
export interface StructuredChatDebugStore {
  /** Replace the current snapshot and notify active subscribers. */
  readonly receive: (snapshot: StructuredChatDebugSnapshot) => void
  /** Subscribe to snapshot replacement. */
  readonly subscribe: (listener: () => void) => () => void
  /** Read the current snapshot, or null before the first reply. */
  readonly getSnapshot: () => StructuredChatDebugSnapshot | null
}

/** Create one isolated structured-chat debug snapshot store. */
export const createStructuredChatDebugStore = (): StructuredChatDebugStore => {
  let current: StructuredChatDebugSnapshot | null = null
  const listeners = new Set<() => void>()

  return {
    receive: (snapshot) => {
      if (Object.is(snapshot, current)) {
        return
      }
      current = snapshot
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // One faulty preview consumer must not leave later panels stale.
        }
      }
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

/** Props for the fixed, collapsible structured-chat debug panel. */
export interface StructuredChatDebugPanelProps {
  readonly store: StructuredChatDebugStore
  readonly position?: StructuredChatDebugPanelPosition
  readonly theme?: StructuredChatDebugPanelTheme
  readonly defaultOpen?: boolean
}

type DebugStage = StructuredChatDebugSnapshot["stages"][number]
type DebugCollectStage = Extract<DebugStage, { readonly _tag: "CollectStage" }>
type DebugField = DebugCollectStage["fields"][number]
type DebugQuestion = DebugField["question"]
type DebugFieldState = DebugField["state"]
type DebugIssuedQuestion = Extract<
  DebugFieldState,
  { readonly _tag: "Asked" }
>["issuedQuestion"]
type DebugAcceptedState = Extract<
  DebugFieldState,
  { readonly _tag: "Accepted" }
>
type DebugEvidence = NonNullable<DebugAcceptedState["evidence"]>
type DebugValue = DebugAcceptedState["value"]
type IconProps = { readonly className?: string }
type CopyFeedback =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Copied"; readonly json: string }
  | { readonly _tag: "Failed"; readonly json: string }

const panelCss = `
.pcsc-debug {
  --pcsc-ease-out: cubic-bezier(.23, 1, .32, 1);

  --pcsc-bg: rgba(16, 17, 20, .94);
  --pcsc-raised: #17191d;
  --pcsc-well: #1c1f24;
  --pcsc-hover: rgba(255, 255, 255, .04);
  --pcsc-border: #23262c;
  --pcsc-border-strong: #30343c;
  --pcsc-text: #eceef1;
  --pcsc-text-2: #9aa0aa;
  --pcsc-text-3: #6a707a;

  --pcsc-accent: #7f9cf5;
  --pcsc-accent-soft: rgba(127, 156, 245, .1);
  --pcsc-ok: #5ec99b;
  --pcsc-ok-muted: rgba(94, 201, 155, .4);
  --pcsc-warn: #e0b34a;
  --pcsc-warn-soft: rgba(224, 179, 74, .09);

  --pcsc-shadow:
    0 1px 2px rgba(0, 0, 0, .3),
    0 8px 24px -8px rgba(0, 0, 0, .5),
    0 32px 56px -16px rgba(0, 0, 0, .45);

  position: fixed;
  z-index: 2147483000;
  width: min(360px, calc(100vw - 32px));
  max-height: min(720px, calc(100dvh - 32px));
  overflow: hidden;
  isolation: isolate;
  color: var(--pcsc-text);
  background: var(--pcsc-bg);
  border: 1px solid var(--pcsc-border);
  border-radius: 12px;
  box-shadow: var(--pcsc-shadow);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  font: 400 12px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.003em;
  color-scheme: dark;
}

.pcsc-debug,
.pcsc-debug * {
  box-sizing: border-box;
}

.pcsc-debug[data-position="top-left"] {
  top: max(16px, env(safe-area-inset-top, 0px));
  left: max(16px, env(safe-area-inset-left, 0px));
}

.pcsc-debug[data-position="top-right"] {
  top: max(16px, env(safe-area-inset-top, 0px));
  right: max(16px, env(safe-area-inset-right, 0px));
}

.pcsc-debug[data-position="bottom-left"] {
  bottom: max(16px, env(safe-area-inset-bottom, 0px));
  left: max(16px, env(safe-area-inset-left, 0px));
}

.pcsc-debug[data-position="bottom-right"] {
  right: max(16px, env(safe-area-inset-right, 0px));
  bottom: max(16px, env(safe-area-inset-bottom, 0px));
}

.pcsc-debug[data-theme="light"] {
  --pcsc-bg: rgba(255, 255, 255, .94);
  --pcsc-raised: #f7f8f9;
  --pcsc-well: #f1f3f5;
  --pcsc-hover: rgba(0, 0, 0, .035);
  --pcsc-border: #e4e6ea;
  --pcsc-border-strong: #d2d6dc;
  --pcsc-text: #16181c;
  --pcsc-text-2: #5b616b;
  --pcsc-text-3: #868d97;

  --pcsc-accent: #4f5bd5;
  --pcsc-accent-soft: rgba(79, 91, 213, .06);
  --pcsc-ok: #2f9e6f;
  --pcsc-ok-muted: rgba(47, 158, 111, .4);
  --pcsc-warn: #9a7011;
  --pcsc-warn-soft: rgba(154, 112, 17, .08);

  --pcsc-shadow:
    0 1px 2px rgba(16, 18, 22, .06),
    0 8px 24px -8px rgba(16, 18, 22, .12),
    0 32px 56px -16px rgba(16, 18, 22, .14);

  color-scheme: light;
}

@media (prefers-color-scheme: light) {
  .pcsc-debug[data-theme="system"] {
    --pcsc-bg: rgba(255, 255, 255, .94);
    --pcsc-raised: #f7f8f9;
    --pcsc-well: #f1f3f5;
    --pcsc-hover: rgba(0, 0, 0, .035);
    --pcsc-border: #e4e6ea;
    --pcsc-border-strong: #d2d6dc;
    --pcsc-text: #16181c;
    --pcsc-text-2: #5b616b;
    --pcsc-text-3: #868d97;

    --pcsc-accent: #4f5bd5;
    --pcsc-accent-soft: rgba(79, 91, 213, .06);
    --pcsc-ok: #2f9e6f;
    --pcsc-ok-muted: rgba(47, 158, 111, .4);
    --pcsc-warn: #9a7011;
    --pcsc-warn-soft: rgba(154, 112, 17, .08);

    --pcsc-shadow:
      0 1px 2px rgba(16, 18, 22, .06),
      0 8px 24px -8px rgba(16, 18, 22, .12),
      0 32px 56px -16px rgba(16, 18, 22, .14);

    color-scheme: light;
  }
}

/* ---------- collapsed ---------- */

.pcsc-debug[data-open="false"] {
  width: 40px;
  height: 40px;
  border-radius: 999px;
}

.pcsc-debug[data-open="false"] .pcsc-debug__header {
  min-height: 38px;
  padding: 0;
  border-bottom: 0;
}

.pcsc-debug[data-open="false"] .pcsc-debug__mark,
.pcsc-debug[data-open="false"] .pcsc-debug__title,
.pcsc-debug[data-open="false"] .pcsc-debug__copy {
  display: none;
}

.pcsc-debug[data-open="false"] .pcsc-debug__actions {
  width: 38px;
  height: 38px;
}

.pcsc-debug[data-open="false"] .pcsc-debug__toggle {
  width: 38px;
  height: 38px;
  color: var(--pcsc-text-2);
  border-radius: 999px;
}

/* ---------- header ---------- */

.pcsc-debug__header {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--pcsc-border);
}

.pcsc-debug__mark {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  color: var(--pcsc-text-3);
}

.pcsc-debug__mark .pcsc-debug__icon {
  width: 16px;
  height: 16px;
}

.pcsc-debug__title {
  min-width: 0;
  flex: 1;
}

.pcsc-debug__title > h2,
.pcsc-debug__title > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcsc-debug__title h2 {
  padding: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -.012em;
}

.pcsc-debug__title span {
  color: var(--pcsc-text-3);
  font-size: 11px;
}

.pcsc-debug__status-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--pcsc-accent);
  vertical-align: 1px;
}

.pcsc-debug[data-chat-status="complete"] .pcsc-debug__status-dot {
  background: var(--pcsc-ok);
}

.pcsc-debug__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* ---------- controls ---------- */

.pcsc-debug button {
  display: inline-grid;
  width: 32px;
  height: 32px;
  padding: 0;
  place-items: center;
  color: var(--pcsc-text-3);
  background: transparent;
  border: 0;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transform-origin: center;
  transition:
    color 120ms ease,
    background-color 120ms ease,
    transform 140ms var(--pcsc-ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .pcsc-debug button:hover:not(:disabled) {
    color: var(--pcsc-text);
    background: var(--pcsc-hover);
  }
}

.pcsc-debug button:active:not(:disabled) {
  transform: scale(.96);
}

.pcsc-debug button:focus-visible,
.pcsc-debug summary:focus-visible {
  outline: 2px solid var(--pcsc-accent);
  outline-offset: -2px;
}

.pcsc-debug button:disabled {
  opacity: .4;
  cursor: not-allowed;
}

.pcsc-debug__icon {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}

.pcsc-debug__copy-glyph {
  display: grid;
  place-items: center;
  opacity: 1;
  transform: scale(1);
  transition:
    opacity 120ms ease,
    transform 140ms var(--pcsc-ease-out);
}

@starting-style {
  .pcsc-debug__copy-glyph {
    opacity: 0;
    transform: scale(.94);
  }
}

.pcsc-debug__toggle .pcsc-debug__toggle-glyph {
  transition: transform 160ms var(--pcsc-ease-out);
}

.pcsc-debug__toggle-chevron {
  transform: rotate(180deg);
}

/* ---------- body ---------- */

.pcsc-debug__body {
  max-height: calc(min(720px, 100dvh - 32px) - 48px);
  overflow: auto;
  padding: 4px 8px 8px;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-color: var(--pcsc-border-strong) transparent;
  scrollbar-width: thin;
}

.pcsc-debug__flow-heading,
.pcsc-debug__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pcsc-debug__flow-heading {
  padding: 10px 6px 8px;
  color: var(--pcsc-text-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
}

.pcsc-debug__step-count {
  color: var(--pcsc-text-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .07em;
}

.pcsc-debug__stage-list {
  display: grid;
  gap: 2px;
}

.pcsc-debug details,
.pcsc-debug summary {
  margin: 0;
}

.pcsc-debug summary {
  list-style: none;
  -webkit-tap-highlight-color: transparent;
}

.pcsc-debug summary::-webkit-details-marker {
  display: none;
}

/* ---------- stage ---------- */

.pcsc-debug__stage {
  position: relative;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
}

.pcsc-debug__stage[data-status="current"] {
  background: var(--pcsc-raised);
  border-color: var(--pcsc-border);
}

.pcsc-debug__stage-summary {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
}

@media (hover: hover) and (pointer: fine) {
  .pcsc-debug__stage-summary:hover,
  .pcsc-debug__answer-summary:hover,
  .pcsc-debug__raw > summary:hover {
    background: var(--pcsc-hover);
  }
}

.pcsc-debug__stage-title {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
  color: var(--pcsc-text-2);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -.012em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcsc-debug__stage[data-status="current"] .pcsc-debug__stage-title {
  color: var(--pcsc-text);
}

.pcsc-debug__stage-meta {
  flex: 0 0 auto;
  color: var(--pcsc-text-3);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.pcsc-debug__stage[data-status="current"] .pcsc-debug__stage-meta {
  color: var(--pcsc-accent);
}

/* ---------- status marks ---------- */

.pcsc-debug__status-icon {
  display: grid;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--pcsc-text-3);
}

.pcsc-debug__status-icon .pcsc-debug__icon {
  width: 13px;
  height: 13px;
  stroke-width: 2;
}

.pcsc-debug__status-icon[data-status="complete"],
.pcsc-debug__status-icon[data-status="answered"] {
  color: var(--pcsc-ok);
}

.pcsc-debug__status-icon[data-status="current"],
.pcsc-debug__status-icon[data-status="asked"] {
  color: var(--pcsc-accent);
}

.pcsc-debug__state-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.pcsc-debug__status-icon[data-status="not-asked"] .pcsc-debug__state-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px currentColor;
}

.pcsc-debug__stage-number {
  font-size: 10px;
  font-weight: 600;
}

/* ---------- meter ---------- */

.pcsc-debug__meter {
  display: flex;
  height: 3px;
  gap: 2px;
  margin: 10px 12px;
}

.pcsc-debug__meter-segment {
  min-width: 2px;
  flex: 1;
  background: var(--pcsc-border-strong);
  border-radius: 999px;
}

.pcsc-debug__meter-segment[data-status="answered"] {
  background: var(--pcsc-ok-muted);
}

.pcsc-debug__meter-segment[data-status="asked"] {
  background: var(--pcsc-accent);
}

/* ---------- notice ---------- */

.pcsc-debug__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin: 0 12px 10px;
  color: var(--pcsc-warn);
  background: var(--pcsc-warn-soft);
  border-radius: 6px;
  font-size: 11px;
}

.pcsc-debug__notice-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: currentColor;
}

/* ---------- answers ---------- */

.pcsc-debug__answers {
  border-top: 1px solid var(--pcsc-border);
}

.pcsc-debug__answer + .pcsc-debug__answer {
  border-top: 1px solid var(--pcsc-border);
}

.pcsc-debug__answer-summary {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  cursor: pointer;
  user-select: none;
}

.pcsc-debug__answer-title {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
  color: var(--pcsc-text);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcsc-debug__answer[data-status="not-asked"] .pcsc-debug__answer-title {
  color: var(--pcsc-text-2);
}

.pcsc-debug__answer-preview {
  max-width: 150px;
  flex: 0 0 auto;
  overflow: hidden;
  color: var(--pcsc-text-2);
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcsc-debug__answer-preview[data-status="asked"] {
  color: var(--pcsc-accent);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
}

.pcsc-debug__answer-preview[data-status="not-asked"] {
  color: var(--pcsc-text-3);
}

.pcsc-debug__answer-body {
  display: grid;
  gap: 14px;
  padding: 2px 12px 14px 38px;
  color: var(--pcsc-text-2);
}

/* ---------- data ---------- */

.pcsc-debug__description,
.pcsc-debug__supporting-text,
.pcsc-debug__quote {
  margin: 0;
}

.pcsc-debug__description {
  color: var(--pcsc-text-2);
  font-size: 12px;
}

.pcsc-debug__datum {
  display: grid;
  gap: 6px;
}

.pcsc-debug__datum-label {
  color: var(--pcsc-text-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
}

.pcsc-debug__datum[data-highlighted="true"] .pcsc-debug__question-copy {
  color: var(--pcsc-text);
  background: var(--pcsc-accent-soft);
}

.pcsc-debug__value,
.pcsc-debug__quote,
.pcsc-debug__question-copy {
  padding: 8px 10px;
  color: var(--pcsc-text);
  background: var(--pcsc-well);
  border-radius: 6px;
  overflow-wrap: anywhere;
}

.pcsc-debug__value {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  font: 400 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.pcsc-debug__value--plain {
  font: 500 12px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.pcsc-debug__quote {
  color: var(--pcsc-text-2);
  font-size: 12px;
  font-style: normal;
}

.pcsc-debug__question-copy {
  margin: 0;
  font-size: 12px;
}

.pcsc-debug__supporting-text {
  color: var(--pcsc-text-3);
  font-size: 11px;
}

.pcsc-debug__choices,
.pcsc-debug__actions-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0;
  margin: 2px 0 0;
  list-style: none;
}

.pcsc-debug__choice,
.pcsc-debug__action {
  padding: 3px 8px;
  color: var(--pcsc-text-2);
  background: var(--pcsc-well);
  border-radius: 999px;
  font-size: 11px;
}

.pcsc-debug__rule {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--pcsc-text-3);
  font-size: 11px;
}

.pcsc-debug__rule code {
  color: var(--pcsc-text-2);
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---------- disclosure ---------- */

.pcsc-debug__chevron {
  display: grid;
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--pcsc-text-3);
  transform-origin: center;
  transition: transform 160ms var(--pcsc-ease-out);
}

.pcsc-debug__chevron .pcsc-debug__icon {
  width: 12px;
  height: 12px;
}

.pcsc-debug__toggle-glyph {
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  transform-origin: center;
}

.pcsc-debug details[open] > summary .pcsc-debug__chevron {
  transform: rotate(180deg);
}

.pcsc-debug__stage-body {
  padding-top: 2px;
  border-top: 1px solid var(--pcsc-border);
}

.pcsc-debug__stage-content {
  display: grid;
  gap: 14px;
  padding: 12px 12px 14px;
}

.pcsc-debug__definition {
  border-top: 1px solid var(--pcsc-border);
}

.pcsc-debug__definition > summary {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--pcsc-text-3);
  cursor: pointer;
  font-size: 11px;
  user-select: none;
}

@media (hover: hover) and (pointer: fine) {
  .pcsc-debug__definition > summary:hover {
    color: var(--pcsc-text-2);
  }
}

.pcsc-debug__definition-body {
  display: grid;
  gap: 14px;
  padding: 4px 0 4px;
}

.pcsc-debug__raw {
  margin-top: 8px !important;
  border-top: 1px solid var(--pcsc-border);
}

.pcsc-debug__raw > summary {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px;
  color: var(--pcsc-text-3);
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  user-select: none;
}

.pcsc-debug__json {
  max-height: 240px;
  overflow: auto;
  padding: 10px;
  margin: 0 0 8px;
  color: var(--pcsc-text-2);
  background: var(--pcsc-well);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 400 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---------- footer / empty ---------- */

.pcsc-debug__footer {
  min-height: 30px;
  padding: 0 6px;
  color: var(--pcsc-text-3);
  font-size: 11px;
}

.pcsc-debug__copy-status {
  min-width: 42px;
  color: var(--pcsc-text-2);
  text-align: right;
}

.pcsc-debug__empty {
  display: grid;
  min-height: 132px;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.pcsc-debug__empty-mark {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  color: var(--pcsc-text-3);
  background: var(--pcsc-well);
  border-radius: 8px;
}

.pcsc-debug__empty strong {
  color: var(--pcsc-text);
  font-size: 12px;
  font-weight: 600;
}

.pcsc-debug__empty span {
  color: var(--pcsc-text-3);
  font-size: 11px;
}

.pcsc-debug__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ---------- responsive ---------- */

@media (max-width: 480px) {
  .pcsc-debug[data-open="true"] {
    right: max(8px, env(safe-area-inset-right, 0px)) !important;
    bottom: max(8px, env(safe-area-inset-bottom, 0px)) !important;
    left: max(8px, env(safe-area-inset-left, 0px)) !important;
    top: auto !important;
    width: auto;
    max-height: calc(100dvh - 16px);
  }

  .pcsc-debug[data-open="false"] {
    right: max(8px, env(safe-area-inset-right, 0px)) !important;
    bottom: max(8px, env(safe-area-inset-bottom, 0px)) !important;
    left: auto !important;
    top: auto !important;
  }

  .pcsc-debug__body {
    max-height: calc(100dvh - 64px);
  }

  .pcsc-debug[data-open="true"] button {
    width: 36px;
    height: 36px;
  }

  .pcsc-debug__answer-summary,
  .pcsc-debug__stage-summary {
    min-height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pcsc-debug button:active:not(:disabled) {
    transform: none;
  }

  .pcsc-debug__toggle .pcsc-debug__toggle-glyph,
  .pcsc-debug__chevron {
    transition: none;
  }

  .pcsc-debug__copy-glyph {
    transform: none;
    transition: opacity 100ms ease;
  }
}
`

const FlowIcon = ({ className = "pcsc-debug__icon" }: IconProps) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 4.5h10M5 10h10M5 15.5h10" />
    <circle cx="7.5" cy="4.5" r="1.5" />
    <circle cx="12.5" cy="10" r="1.5" />
    <circle cx="9" cy="15.5" r="1.5" />
  </svg>
)

const CopyIcon = ({ className = "pcsc-debug__icon" }: IconProps) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
    <rect x="6.5" y="6.5" width="9" height="9" rx="2" />
    <path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5" />
  </svg>
)

const CheckIcon = ({ className = "pcsc-debug__icon" }: IconProps) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
    <path d="m5 10.5 3.1 3L15 6.8" />
  </svg>
)

const ChevronIcon = ({ className = "pcsc-debug__chevron" }: IconProps) => (
  <span className={className} aria-hidden="true">
    <svg className="pcsc-debug__icon" viewBox="0 0 20 20">
      <path d="m6 8 4 4 4-4" />
    </svg>
  </span>
)

const humanizeIdentifier = (identifier: string): string =>
  identifier
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ")

const stageKindLabel = (stage: DebugStage): string => {
  switch (stage._tag) {
    case "CollectStage":
      return "Questions"
    case "ToolStage":
      return "Actions"
    case "CommandStage":
      return "Final Step"
  }
}

const stageStatusLabel = (status: DebugStage["status"]): string => {
  switch (status) {
    case "complete":
      return "Complete"
    case "current":
      return "Current Step"
    case "upcoming":
      return "Upcoming"
  }
}

const fieldStateName = (
  state: DebugFieldState,
): "answered" | "asked" | "not-asked" => {
  switch (state._tag) {
    case "Accepted":
      return "answered"
    case "Asked":
      return "asked"
    case "Missing":
      return "not-asked"
  }
}

const fieldStateLabel = (state: DebugFieldState): string => {
  switch (state._tag) {
    case "Accepted":
      return "Answered"
    case "Asked":
      return "Awaiting Answer"
    case "Missing":
      return "Not Asked"
  }
}

const answerModeLabel = (mode: DebugField["mode"]): string => {
  switch (mode) {
    case "semantic":
      return "Natural language"
    case "explicit":
      return "Direct response"
    case "confirmed":
      return "Confirmation"
  }
}

const StageStatusIcon = ({ stage }: { readonly stage: DebugStage }) => (
  <span
    className="pcsc-debug__status-icon"
    data-status={stage.status}
    aria-hidden="true"
  >
    {stage.status === "complete" ? (
      <CheckIcon />
    ) : (
      <span className="pcsc-debug__stage-number">{stage.index + 1}</span>
    )}
  </span>
)

const FieldStatusIcon = ({ state }: { readonly state: DebugFieldState }) => {
  const stateName = fieldStateName(state)
  return (
    <span
      className="pcsc-debug__status-icon"
      data-status={stateName}
      aria-hidden="true"
    >
      {stateName === "answered" ? (
        <CheckIcon />
      ) : (
        <span className="pcsc-debug__state-dot" />
      )}
    </span>
  )
}

const ChoiceList = ({ choices }: { readonly choices: ReadonlyArray<string> }) =>
  choices.length === 0 ? null : (
    <ul className="pcsc-debug__choices" aria-label="Suggested choices">
      {choices.map((choice) => (
        <li className="pcsc-debug__choice" key={choice}>
          {choice}
        </li>
      ))}
    </ul>
  )

const questionContent = (question: DebugQuestion): ReactNode => {
  switch (question._tag) {
    case "FixedQuestion":
      return <p className="pcsc-debug__question-copy">{question.text}</p>
    case "AdaptiveQuestion":
      return (
        <>
          <p className="pcsc-debug__question-copy">{question.fallback}</p>
          <p className="pcsc-debug__supporting-text">
            Intent: {question.goal}
          </p>
        </>
      )
    case "AdaptiveChoiceQuestion":
      return (
        <>
          <p className="pcsc-debug__question-copy">{question.prompt}</p>
          <p className="pcsc-debug__supporting-text">
            Suggests {question.minimumOptions}–{question.maximumOptions} choices
          </p>
          <ChoiceList choices={question.fallbackOptions} />
        </>
      )
    case "ChoiceQuestion":
      return (
        <>
          <p className="pcsc-debug__question-copy">{question.text}</p>
          <ChoiceList choices={question.options.map(({ label }) => label)} />
        </>
      )
  }
}

const QuestionDetails = ({ question }: { readonly question: DebugQuestion }) => (
  <section className="pcsc-debug__datum">
    <span className="pcsc-debug__datum-label">Planned Question</span>
    {questionContent(question)}
  </section>
)

const IssuedQuestionDetails = ({
  issuedQuestion,
  highlighted = false,
}: {
  readonly issuedQuestion: DebugIssuedQuestion
  readonly highlighted?: boolean
}) => (
  <section className="pcsc-debug__datum" data-highlighted={highlighted}>
    <span className="pcsc-debug__datum-label">First Asked As</span>
    <p className="pcsc-debug__question-copy">{issuedQuestion.text}</p>
    <p className="pcsc-debug__supporting-text">
      First recorded in assistant message {issuedQuestion.messageIndex + 1}
    </p>
  </section>
)

const EvidenceDetails = ({
  evidence,
}: {
  readonly evidence: DebugEvidence | null
}) => (
  <section className="pcsc-debug__datum">
    <span className="pcsc-debug__datum-label">Based On</span>
    {evidence === null ? (
      <p className="pcsc-debug__supporting-text">
        Source text is not included in this preview.
      </p>
    ) : (
      <>
        <blockquote className="pcsc-debug__quote">{evidence.quote}</blockquote>
        <p className="pcsc-debug__supporting-text">
          User message {evidence.messageIndex + 1}
        </p>
      </>
    )}
  </section>
)

const answerValuePreview = (value: DebugValue): string => {
  if (value === "") {
    return "Empty"
  }
  if (value === true || value === false) {
    return value ? "Yes" : "No"
  }
  if (value === null) {
    return "Null"
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`
  }
  if (value instanceof Object) {
    return `{${Object.keys(value).length}}`
  }
  return String(value)
}

/**
 * Summarize one field for the right-hand column of a collapsed row.
 *
 * The column is narrow, so it carries a scannable token rather than prose.
 * Full questions, values, and evidence stay in the expanded body.
 */
const fieldPreview = (field: DebugField): string => {
  switch (field.state._tag) {
    case "Accepted":
      return answerValuePreview(field.state.value)
    case "Asked":
      return "Awaiting"
    case "Missing":
      return "\u2014"
  }
}

const AnswerValue = ({ value }: { readonly value: DebugValue }) => {
  if (value instanceof Object) {
    return (
      <pre className="pcsc-debug__value" translate="no">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  if (value === "") {
    return (
      <p className="pcsc-debug__value pcsc-debug__value--plain">
        Empty answer
      </p>
    )
  }
  if (value === true || value === false) {
    return (
      <p className="pcsc-debug__value pcsc-debug__value--plain">
        {value ? "Yes" : "No"}
      </p>
    )
  }
  if (value === null) {
    return (
      <p className="pcsc-debug__value pcsc-debug__value--plain">Null</p>
    )
  }
  return (
    <p className="pcsc-debug__value pcsc-debug__value--plain">
      {String(value)}
    </p>
  )
}

const FieldStateDetails = ({
  field,
  highlightIssuedQuestion,
}: {
  readonly field: DebugField
  readonly highlightIssuedQuestion: boolean
}) => {
  switch (field.state._tag) {
    case "Missing":
      return (
        <p className="pcsc-debug__supporting-text">
          This answer has not been requested yet.
        </p>
      )
    case "Asked":
      return (
        <IssuedQuestionDetails
          highlighted={highlightIssuedQuestion}
          issuedQuestion={field.state.issuedQuestion}
        />
      )
    case "Accepted":
      return (
        <>
          <section className="pcsc-debug__datum">
            <span className="pcsc-debug__datum-label">Answer</span>
            <AnswerValue value={field.state.value} />
          </section>
          <EvidenceDetails evidence={field.state.evidence} />
          {field.state.issuedQuestion === null ? null : (
            <IssuedQuestionDetails
              issuedQuestion={field.state.issuedQuestion}
            />
          )}
        </>
      )
  }
}

const AnswerDefinition = ({ field }: { readonly field: DebugField }) => (
  <details className="pcsc-debug__definition">
    <summary>
      <span>Definition</span>
      <ChevronIcon />
    </summary>
    <div className="pcsc-debug__definition-body">
      <section className="pcsc-debug__datum">
        <span className="pcsc-debug__datum-label">Purpose</span>
        <p className="pcsc-debug__description">{field.description}</p>
      </section>
      <QuestionDetails question={field.question} />
      <div className="pcsc-debug__rule">
        <span>Schema Key</span>
        <code translate="no">{field.field}</code>
      </div>
      <div className="pcsc-debug__rule">
        <span>Answer Rule</span>
        <code>{answerModeLabel(field.mode)}</code>
      </div>
    </div>
  </details>
)

const AnswerDetails = ({
  field,
  isFocusedAnswer,
}: {
  readonly field: DebugField
  readonly isFocusedAnswer: boolean
}) => {
  const stateName = fieldStateName(field.state)
  return (
    <details
      className="pcsc-debug__answer"
      data-focused-answer={isFocusedAnswer ? "true" : undefined}
      data-status={stateName}
      open={isFocusedAnswer}
    >
      <summary className="pcsc-debug__answer-summary">
        <FieldStatusIcon state={field.state} />
        <span className="pcsc-debug__answer-title">
          {humanizeIdentifier(field.field)}
          <span className="pcsc-debug__sr-only">
            {`, ${fieldStateLabel(field.state)}`}
          </span>
        </span>
        <span className="pcsc-debug__answer-preview" data-status={stateName}>
          {fieldPreview(field)}
        </span>
        <ChevronIcon />
      </summary>
      <div className="pcsc-debug__answer-body">
        <FieldStateDetails
          field={field}
          highlightIssuedQuestion={isFocusedAnswer}
        />
        <AnswerDefinition field={field} />
      </div>
    </details>
  )
}

/** Right-aligned stage metric: progress where it exists, otherwise the kind. */
const stageMetaLabel = (stage: DebugStage): string =>
  stage._tag === "CollectStage"
    ? `${stage.satisfiedFields}/${stage.totalFields}`
    : stageKindLabel(stage)

const StageSummary = ({ stage }: { readonly stage: DebugStage }) => (
  <summary className="pcsc-debug__stage-summary">
    <StageStatusIcon stage={stage} />
    <span className="pcsc-debug__stage-title">
      {humanizeIdentifier(stage.name)}
      <span className="pcsc-debug__sr-only">
        {`, ${stageKindLabel(stage)}, ${stageStatusLabel(stage.status)}`}
      </span>
    </span>
    <span className="pcsc-debug__stage-meta">{stageMetaLabel(stage)}</span>
    <ChevronIcon />
  </summary>
)

const RepairNotice = ({ repairPending }: { readonly repairPending: boolean }) =>
  repairPending ? (
    <div className="pcsc-debug__notice">
      <span className="pcsc-debug__notice-dot" aria-hidden="true" />
      This step needs review before continuing
    </div>
  ) : null

const mostRecentlyFirstAskedField = (
  fields: ReadonlyArray<DebugField>,
): DebugField | null => {
  let mostRecent: DebugField | null = null
  let mostRecentMessageIndex = -1

  for (const field of fields) {
    if (
      field.state._tag === "Asked" &&
      field.state.issuedQuestion.messageIndex > mostRecentMessageIndex
    ) {
      mostRecent = field
      mostRecentMessageIndex = field.state.issuedQuestion.messageIndex
    }
  }

  return mostRecent
}

const CollectStageDetails = ({ stage }: { readonly stage: DebugCollectStage }) => {
  const focusedAnswer =
    stage.status === "current"
      ? mostRecentlyFirstAskedField(stage.fields)
      : null

  return (
    <details
      className="pcsc-debug__stage"
      data-status={stage.status}
      aria-current={stage.status === "current" ? "step" : undefined}
      open={stage.status === "current"}
    >
      <StageSummary stage={stage} />
      <div className="pcsc-debug__stage-body">
        <h3 className="pcsc-debug__sr-only">Required Answers</h3>
        <div
          className="pcsc-debug__meter"
          role="progressbar"
          aria-label={`${stage.satisfiedFields} of ${stage.totalFields} answered`}
          aria-valuemin={0}
          aria-valuemax={stage.totalFields}
          aria-valuenow={stage.satisfiedFields}
        >
          {stage.fields.map((field) => (
            <span
              className="pcsc-debug__meter-segment"
              data-status={fieldStateName(field.state)}
              key={field.field}
              aria-hidden="true"
            />
          ))}
        </div>
        <RepairNotice repairPending={stage.repairPending} />
        <div className="pcsc-debug__answers">
          {stage.fields.map((field) => (
            <AnswerDetails
              field={field}
              isFocusedAnswer={field === focusedAnswer}
              key={field.field}
            />
          ))}
        </div>
      </div>
    </details>
  )
}

const ToolStageDetails = ({
  stage,
}: {
  readonly stage: Extract<DebugStage, { readonly _tag: "ToolStage" }>
}) => (
  <details
    className="pcsc-debug__stage"
    data-status={stage.status}
    aria-current={stage.status === "current" ? "step" : undefined}
    open={stage.status === "current"}
  >
    <StageSummary stage={stage} />
    <div className="pcsc-debug__stage-body">
      <RepairNotice repairPending={stage.repairPending} />
      <div className="pcsc-debug__stage-content">
        <section className="pcsc-debug__datum">
          <span className="pcsc-debug__datum-label">Available Actions</span>
          <ul className="pcsc-debug__actions-list">
            {stage.tools.map((tool) => (
              <li className="pcsc-debug__action" key={tool}>
                {humanizeIdentifier(tool)}
              </li>
            ))}
          </ul>
        </section>
        <p className="pcsc-debug__supporting-text">
          {stage.afterExecution === "stay"
            ? "This step stays open after each action."
            : "The conversation completes after this action runs."}
        </p>
      </div>
    </div>
  </details>
)

const CommandStageDetails = ({
  stage,
}: {
  readonly stage: Extract<DebugStage, { readonly _tag: "CommandStage" }>
}) => (
  <details
    className="pcsc-debug__stage"
    data-status={stage.status}
    aria-current={stage.status === "current" ? "step" : undefined}
    open={stage.status === "current"}
  >
    <StageSummary stage={stage} />
    <div className="pcsc-debug__stage-body">
      <RepairNotice repairPending={stage.repairPending} />
      <div className="pcsc-debug__stage-content">
        <section className="pcsc-debug__datum">
          <span className="pcsc-debug__datum-label">Final Action</span>
          <p className="pcsc-debug__question-copy">
            {humanizeIdentifier(stage.command)}
          </p>
        </section>
      </div>
    </div>
  </details>
)

const StageDetails = ({ stage }: { readonly stage: DebugStage }) => {
  switch (stage._tag) {
    case "CollectStage":
      return <CollectStageDetails stage={stage} />
    case "ToolStage":
      return <ToolStageDetails stage={stage} />
    case "CommandStage":
      return <CommandStageDetails stage={stage} />
  }
}

const snapshotAnnouncement = (
  snapshot: StructuredChatDebugSnapshot | null,
): string => {
  if (snapshot === null) {
    return "Waiting for the first reply."
  }

  const stage = snapshot.stages.find(
    ({ index }) => index === snapshot.currentStage.index,
  )
  const stageName = humanizeIdentifier(snapshot.currentStage.name)
  if (stage?._tag === "CollectStage") {
    return `${stageName} is current. ${stage.satisfiedFields} of ${stage.totalFields} required answers are answered.`
  }
  return `${stageName} is the current step.`
}

/** Render one fixed, accessible inspector for the latest debug snapshot. */
export const StructuredChatDebugPanel = ({
  store,
  position = "bottom-right",
  theme = "system",
  defaultOpen = true,
}: StructuredChatDebugPanelProps) => {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const [open, setOpen] = useState(defaultOpen)
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({
    _tag: "Idle",
  })
  const contentId = useId()
  const rawJson = useMemo(
    () => (snapshot === null ? "" : JSON.stringify(snapshot, null, 2)),
    [snapshot],
  )
  const copyStatus =
    copyFeedback._tag === "Idle" || copyFeedback.json !== rawJson
      ? "idle"
      : copyFeedback._tag === "Copied"
        ? "copied"
        : "failed"

  useEffect(() => {
    if (copyStatus === "idle") {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCopyFeedback({ _tag: "Idle" })
    }, 1600)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [copyStatus])

  const copyJson = async (): Promise<void> => {
    const jsonToCopy = rawJson
    try {
      if (navigator.clipboard === undefined) {
        setCopyFeedback({ _tag: "Failed", json: jsonToCopy })
        return
      }
      await navigator.clipboard.writeText(jsonToCopy)
      setCopyFeedback({ _tag: "Copied", json: jsonToCopy })
    } catch {
      setCopyFeedback({ _tag: "Failed", json: jsonToCopy })
    }
  }

  return (
    <>
      <style>{panelCss}</style>
      <aside
        className="pcsc-debug"
        data-open={open}
        data-position={position}
        data-theme={theme}
        data-chat-status={snapshot?.status ?? "waiting"}
        aria-label="Structured chat debug inspector"
      >
        <span className="pcsc-debug__sr-only" role="status" aria-atomic="true">
          {snapshotAnnouncement(snapshot)}
        </span>
        <header className="pcsc-debug__header">
          <span className="pcsc-debug__mark" aria-hidden="true">
            <FlowIcon />
          </span>
          <div className="pcsc-debug__title">
            <h2>
              {snapshot === null
                ? "Chat Flow"
                : humanizeIdentifier(snapshot.chat.name)}
            </h2>
            <span>
              {snapshot === null ? (
                "Waiting for a reply"
              ) : (
                <>
                  <span className="pcsc-debug__status-dot" aria-hidden="true" />
                  {snapshot.status === "complete" ? "Complete" : "In Progress"}
                  {` · Version ${snapshot.chat.version}`}
                </>
              )}
            </span>
          </div>
          <div className="pcsc-debug__actions">
            <button
              className="pcsc-debug__copy"
              type="button"
              disabled={snapshot === null}
              onClick={() => {
                void copyJson()
              }}
              aria-label="Copy debug state as JSON"
              title={copyStatus === "copied" ? "Copied" : "Copy State"}
            >
              <span className="pcsc-debug__copy-glyph" key={copyStatus}>
                {copyStatus === "copied" ? <CheckIcon /> : <CopyIcon />}
              </span>
            </button>
            <button
              className="pcsc-debug__toggle"
              type="button"
              onClick={() => {
                setOpen((current) => !current)
              }}
              aria-expanded={open}
              aria-controls={contentId}
              aria-label={open ? "Collapse debug panel" : "Expand debug panel"}
            >
              {open ? (
                <ChevronIcon className="pcsc-debug__toggle-glyph pcsc-debug__toggle-chevron" />
              ) : (
                <FlowIcon />
              )}
            </button>
          </div>
        </header>

        <div id={contentId} className="pcsc-debug__body" hidden={!open}>
          {snapshot === null ? (
            <div className="pcsc-debug__empty">
              <span className="pcsc-debug__empty-mark" aria-hidden="true">
                <FlowIcon />
              </span>
              <strong>Ready for the first reply</strong>
              <span>The conversation map will appear here.</span>
            </div>
          ) : (
            <>
              <div className="pcsc-debug__flow-heading">
                <span>Conversation Flow</span>
                <span className="pcsc-debug__step-count">
                  Step {snapshot.currentStage.index + 1} of {snapshot.stages.length}
                </span>
              </div>

              <div className="pcsc-debug__stage-list" aria-label="Chat stages">
                {snapshot.stages.map((stage) => (
                  <StageDetails
                    stage={stage}
                    key={`${stage.index}:${stage.name}`}
                  />
                ))}
              </div>

              <details className="pcsc-debug__raw">
                <summary>
                  <span>Raw State</span>
                  <ChevronIcon />
                </summary>
                <pre className="pcsc-debug__json" translate="no">
                  {rawJson}
                </pre>
              </details>
            </>
          )}
          <footer className="pcsc-debug__footer">
            <span>Preview · includes chat answers</span>
            <span
              className="pcsc-debug__copy-status"
              role="status"
              aria-live="polite"
            >
              {copyStatus === "copied"
                ? "Copied"
                : copyStatus === "failed"
                  ? "Copy failed · use Raw State"
                  : ""}
            </span>
          </footer>
        </div>
      </aside>
    </>
  )
}
