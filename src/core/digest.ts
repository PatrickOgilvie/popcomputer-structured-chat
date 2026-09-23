import { Effect } from "effect"

/** @internal Lowercase hexadecimal SHA-256 of one UTF-8 string, via Web Crypto. */
export const sha256Hex = (input: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    )

    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  })
