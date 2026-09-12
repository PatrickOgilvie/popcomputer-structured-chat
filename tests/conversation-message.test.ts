import { describe, expect, test } from "bun:test"
import { Predicate, Result, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Session } from "../src/index.js"

const Message = Session.Message

describe("source-bearing conversation messages", () => {
  test.each([
    { role: "user", content: "Yes" },
    { _tag: "Submitted", role: "assistant", content: "Yes" },
    { _tag: "Authored", role: "user", content: "Yes" },
    { _tag: "Observed", role: "user", content: "Yes", id: "missing-batch" },
    { _tag: "Observed", role: "user", content: "Yes", batchId: "missing-id" },
    { _tag: "Authored", role: "assistant", content: "Yes", id: "unexpected" },
  ])(
    "rejects ambiguous or contradictory persisted provenance: %j",
    (message) => {
      // The table deliberately contains malformed storage values, not encoded snapshots.
      const result = Schema.decodeUnknownResult(Session.SnapshotSchema)(
        { revision: "1", state: {}, messages: [message] },
        { onExcessProperty: "error" },
      )

      expect(Result.isFailure(result)).toBe(true)
    },
  )

  test("requires unique observation identities across batches", () => {
    const messages = ["a", "b"].map((batchId) =>
      Message.observed({
        role: "user",
        content: "Yes",
        batchId,
        id: "duplicate",
      }),
    )

    const result = Schema.decodeResult(Session.SnapshotSchema)({
      revision: "1",
      state: {},
      messages,
    })

    expect(Result.isFailure(result)).toBe(true)
  })

  test("finds the latest eligible quote without upgrading observed confirmation", () => {
    const messages = [
      Message.submitted("Yes"),
      Message.authored("Confirm?"),
      Message.submitted("Yes"),
      Message.observed({ role: "user", content: "Yes", batchId: "b", id: "u" }),
      Message.observed({
        role: "assistant",
        content: "Yes",
        batchId: "b",
        id: "a",
      }),
    ]

    expect(
      Message.findEvidence(messages, {
        quote: "Yes",
        afterIndex: 1,
        mode: "semantic",
      }),
    ).toBe(3)
    expect(
      Message.findEvidence(messages, {
        quote: "Yes",
        afterIndex: 1,
        mode: "explicit",
      }),
    ).toBe(3)
    expect(
      Message.findEvidence(messages, {
        quote: "Yes",
        afterIndex: 1,
        mode: "confirmed",
      }),
    ).toBe(2)
    expect(
      Message.findEvidence(messages, {
        quote: "Yes",
        afterIndex: 2,
        mode: "confirmed",
      }),
    ).toBeUndefined()
  })

  test("preserves source authority through JSON round trips for every variant", () => {
    FastCheck.assert(
      FastCheck.property(
        Schema.toArbitrary(Message.ConversationMessageSchema)(FastCheck),
        (message) => {
          const decoded = Schema.decodeUnknownSync(
            Message.ConversationMessageSchema,
          )(JSON.parse(JSON.stringify(message)), { onExcessProperty: "error" })

          expect(decoded).toEqual(message)
          expect(Message.canGroundAnswer(decoded, "confirmed")).toBe(
            Predicate.isTagged(decoded, "Submitted"),
          )
          expect(Message.isAuthored(decoded)).toBe(
            Predicate.isTagged(decoded, "Authored"),
          )
        },
      ),
    )
  })
})
