import * as CloudflareAI from "../src/model/cloudflare-workers-ai.js"
import { describe, expect, test } from "bun:test"

describe("CloudflareAI.classifyError", () => {
  test.each([2017, "2017"])(
    "classifies a numeric or string 2017 code as blocked (%p)",
    (code) => {
      expect(CloudflareAI.classifyError({ code })).toBe(
        "response_blocked",
      )
    },
  )

  test("classifies 2017 found deep in a cause chain as blocked", () => {
    const cause = {
      cause: { cause: { cause: { code: 2017 } } },
    }

    expect(CloudflareAI.classifyError(cause)).toBe(
      "response_blocked",
    )
  })

  test("requires the security-configurations phrase beside a message-form 2017", () => {
    const blocked = new Error(
      "Request failed with code 2017: response blocked due to security configurations",
    )
    const unannotated = new Error("Request failed with code 2017")

    expect(CloudflareAI.classifyError(blocked)).toBe(
      "response_blocked",
    )
    expect(CloudflareAI.classifyError(unannotated)).toBe(
      "request_failed",
    )
  })

  test("walks at most four linked causes", () => {
    const atDepthFour = {
      cause: { cause: { cause: { code: 2017 } } },
    }
    const beyondDepthFour = {
      cause: { cause: { cause: { cause: { code: 2017 } } } },
    }

    expect(CloudflareAI.classifyError(atDepthFour)).toBe(
      "response_blocked",
    )
    expect(CloudflareAI.classifyError(beyondDepthFour)).toBe(
      "request_failed",
    )
  })

  test("terminates on cyclic cause chains", () => {
    const cyclic = {}
    Object.defineProperty(cyclic, "cause", { get: () => cyclic })
    const firstCycleNode = {}
    const secondCycleNode = {}
    Object.defineProperty(firstCycleNode, "cause", {
      get: () => secondCycleNode,
    })
    Object.defineProperty(secondCycleNode, "cause", {
      get: () => firstCycleNode,
    })

    expect(CloudflareAI.classifyError(cyclic)).toBe(
      "request_failed",
    )
    expect(CloudflareAI.classifyError(firstCycleNode)).toBe(
      "request_failed",
    )
  })

  test("classifies unrelated failures as request failures", () => {
    const causes: ReadonlyArray<unknown> = [
      new Error("connection refused"),
      "plain string failure",
      42,
      null,
      undefined,
      {},
      { code: 3003 },
    ]

    for (const cause of causes) {
      expect(CloudflareAI.classifyError(cause)).toBe(
        "request_failed",
      )
    }
  })
})

describe("CloudflareAI.errorCode", () => {
  test("accepts documented direct code properties", () => {
    expect(CloudflareAI.errorCode({ code: 2017 })).toBe("2017")
    expect(CloudflareAI.errorCode({ code: "3003" })).toBe("3003")
  })

  test("rejects unknown direct codes and keeps looking", () => {
    for (const code of [
      "ECONNRESET",
      "tenant_api_token_123",
      "a".repeat(32),
      "x".repeat(33),
      1234,
    ]) {
      expect(CloudflareAI.errorCode({ code })).toBeUndefined()
    }

    const fallsThroughToChain = {
      code: "tenant_api_token_123",
      cause: new Error("code: 3003"),
    }

    expect(CloudflareAI.errorCode(fallsThroughToChain)).toBe(
      "3003",
    )
  })

  test("extracts documented codes from error messages", () => {
    expect(
      CloudflareAI.errorCode(new Error('{"code": 3006}')),
    ).toBe("3006")
    expect(CloudflareAI.errorCode(new Error("code=8007"))).toBe(
      "8007",
    )
    expect(
      CloudflareAI.errorCode(
        new Error("CODE : 5016 while processing"),
      ),
    ).toBe("5016")
    expect(
      CloudflareAI.errorCode(new Error("code: 1234")),
    ).toBeUndefined()
  })

  test("walks the cause chain for codes", () => {
    expect(
      CloudflareAI.errorCode({
        cause: new Error("code: 3003"),
      }),
    ).toBe("3003")
  })

  test("terminates on cyclic chains without a code", () => {
    const cyclic = {}
    Object.defineProperty(cyclic, "code", { value: "" })
    Object.defineProperty(cyclic, "cause", { get: () => cyclic })

    expect(CloudflareAI.errorCode(cyclic)).toBeUndefined()
  })

  test("returns undefined when no code exists", () => {
    expect(CloudflareAI.errorCode(new Error("boom"))).toBeUndefined()
    expect(CloudflareAI.errorCode(42)).toBeUndefined()
    expect(CloudflareAI.errorCode(null)).toBeUndefined()
  })
})
