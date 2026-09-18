# Optional TypeSafe evaluation and collection

Install the optional peer when importing the TypeSafe entry point:

```sh
bun add @typesafe-ai/sdk@^0.6.0
```

```ts
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"
```

The package root does not load the SDK. Existing stages keep their existing extraction behavior until a resolver is attached. Keep the adapter and API key on the server.

## Collect enum and boolean answers

Define the fields once, then bind a resolver to that same object:

```ts
import { Effect, Redacted, Schema } from "effect"
import { Answer, Question, Stage } from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"

const fields = {
  interval: Answer.explicit(Schema.Literals(["monthly", "annual"]), {
    description: "The requested billing interval",
    ask: Question.fixed("Monthly or annual?"),
  }),
}

const Billing = Stage.collect({
  name: "billing",
  fields,
  resolver: TypeSafe.collection(fields, {
    choices: {
      interval: [
        { value: "monthly", meaning: "Pay every month" },
        { value: "annual", meaning: "Pay every year" },
      ],
    },
    acceptance: {
      interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
    },
  }),
})

const evaluatorLayer = (apiKey: Redacted.Redacted<string>, model: string) =>
  TypeSafe.layer({
    apiKey,
    model,
    totalTimeoutMilliseconds: 1_500,
    retry: { maximumAttempts: 2, delayMilliseconds: 100 },
    limits: {
      maximumQuestions: 16,
      maximumStateCharacters: 8_000,
      maximumCandidatesPerField: 16,
    },
  })
```

Provide this layer alongside the ordinary `Model.Service` layer when running the stage or chat. The model service remains a requirement because an input outside the resolver's supported bounds uses the existing generative extraction path. Layer construction can fail with `TypeSafeConfigurationInvalid`; stage and chat errors retain the evaluator's typed failures.

The [compiled example](../examples/typesafe.ts) includes a boolean field and a reusable mixed evaluation. The thresholds and budgets above are application policy examples, not measured accuracy or latency guarantees.

### Evidence and acceptance

Each eligible field becomes an independent Choice question in one batched request. Every field has explicit `no_answer` and `ambiguous` outcomes. A selected candidate must meet both thresholds; absence or low confidence leaves the field pending. Boolean `false` is an answer distinct from abstention.

The first implementation considers only the latest user message and uses its whole trimmed text as the exact evidence quote, capped at 2,000 characters. Candidate meanings should be understandable without earlier conversation context. Context-dependent replies that cannot be resolved from that evidence should abstain. Explicit fields require a stated meaning; semantic fields can infer it. Confirmed fields require an issued question and a subsequent application-submitted answer. Observed speech cannot confirm a field.

The core owns candidate values and evidence. A resolver returns candidate IDs; it cannot invent accepted values or quotes. The core constructs the ordinary `submit_answers` call, parses it, runs post-call guards, and invokes the existing answer validators and merge logic. Pre-call guards run before evaluation. Corrections remain possible while the stage is incomplete; completed stages use the existing repair flow. The exact configured uncertainty escape bypasses inference and retains its existing behavior.

Choices must cover every bound field, contain at least two distinct values of one primitive kind, and pass that answer's schema. Boolean choices include both values. Register all meanings the application needs: the model cannot select an omitted option. The stage fields must be the same object used to construct the resolver. Arbitrary generated strings, numbers, objects, dates, and substring extraction are outside this collection integration.

### Fallback and failures

Evidence over 2,000 characters, too many eligible questions, too many candidates, or serialized state beyond the configured character budget produce a generative fallback. Candidate limits count the two abstention options. The character budget measures serialized JSON in JavaScript string units, not bytes or provider tokens. It does not bound question descriptions; keep application-authored rubrics small.

Abstention, low confidence, provider errors, and malformed responses do not trigger a second extraction strategy. They respectively leave answers pending or fail with a typed error. The adapter retries only transient network/timeout, rate-limit, overload, and server failures. `maximumAttempts` includes the first request and is restricted to 1–3. The total deadline covers all attempts and waits. SDK retries and logs are disabled, and Effect interruption aborts the request or retry wait.

Errors contain bounded reason codes, never credentials, request text, response bodies, or SDK exception messages. Evaluation spans contain model, question count, and usage metadata; collection spans contain selection counts. Ordinary structured-chat debug/session facilities still retain their existing conversation and evidence data.

## Detect answered questions

`TypeSafe.detection(fields, { acceptance })` binds every stage field to one Noul question — "does the latest user message answer this field?" — and evaluates them in one batched request. Fields whose probability meets their `minimumProbability` are the only ones the ordinary generative extraction may fill this turn; when nothing is detected the model is not called and the stage asks its pending question again. Unlike `collection`, detection needs no candidate values, so free-text and other unbounded answers participate.

```ts
const fields = {
  need: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
    description: "The agency need",
    ask: Question.adaptive("Ask what help is needed.", {
      fallback: "What do you need help with?",
    }),
  }),
  budget: Answer.explicit(Schema.Literals(["under_25k", "50k_plus"]), {
    description: "The budget band",
    ask: Question.adaptiveChoice("Ask for the budget band.", {
      minimumOptions: 2,
      maximumOptions: 4,
    }),
  }),
}

const Brief = Stage.collect({
  name: "brief",
  fields,
  detector: TypeSafe.detection(fields, {
    acceptance: {
      need: { minimumProbability: 0.8 },
      budget: { minimumProbability: 0.9 },
    },
    criteria: {
      budget: {
        true: "The message states a budget or spending range.",
        false: "The message does not mention money.",
      },
    },
  }),
})
```

Each Noul carries the field description, the exact issued question text when one has been asked, and the answer mode's grounding rule. Noul returns one probability and no separate confidence, so acceptance uses a probability threshold only. A detector is authoritative for which fields may be filled, but it never supplies values: the existing generative extraction produces them and every existing acceptance rule still applies. One message can mark none, one, or many fields answered — the batched request evaluates all questions at once. Evidence beyond 2,000 characters, or over the configured question and state budgets, falls back to the generative path; provider failures propagate. Detection reads only the latest user message, matching collection. A stage accepts one `resolver` or one `detector`, not both.

## Reuse judgments outside collection

```ts
const questions = TypeSafe.batch({
  route: TypeSafe.choice("Which team should handle this request?", {
    billing: "Payments and invoices",
    support: "Product support",
    neither: "Neither team fits",
  }),
  urgent: TypeSafe.noul("Does the user explicitly need help immediately?"),
  disruption: TypeSafe.score("How much work is blocked?", [
    "No work is blocked",
    "Some work is blocked, but a workaround exists",
    "All relevant work is blocked with no workaround",
  ]),
})

const evaluate = (message: string) => Effect.gen(function* () {
  const evaluator = yield* TypeSafe.Service
  const result = yield* evaluator.evaluate({ state: { message }, questions })
  // result.answers.route.value: "billing" | "support" | "neither"
  return result
})
```

A Noul result exposes `probability`; Choice exposes `value`, `probabilities`, and `confidence`; Score exposes the numeric expected `value`, ordered probabilities, and confidence. A batch preserves literal question and choice names. Inputs are validated and snapshotted, and responses must match the requested question IDs, answer kinds, option sets, and distributions. Application code owns thresholds, routing, and side effects. These Effects can also compose inside `Model.guard`.

TypeSafe documents confidence as distribution concentration, not permission to execute a command or a guarantee of semantic correctness. Calibrate thresholds using representative examples, including ambiguous, contradictory, and adversarial messages. See the [TypeSafe introduction](https://docs.typesafe.ai/introduction), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), and [confidence guidance](https://docs.typesafe.ai/confidence).

## Sessions and verification

Classification happens before the existing optimistic session commit. Provider failure does not persist a partial turn. Concurrent calls may both evaluate, but only the writer with the current revision can commit. Replaying an already-applied observed batch through `Chat.advance` skips inference and writes. Ordinary submitted turns retain their existing semantics and are not deduplicated by this adapter.

The suite exercises the real SDK with deterministic injected fetch responses in Bun, Node ESM, and Cloudflare workerd, plus real D1 persistence, observed replay, and conflicting commits. These tests establish transport and workflow contracts; they do not measure live model quality, production latency, or cost. Run a representative labeled evaluation before enabling the resolver for production traffic.

Probability validation preserves the provider’s values, including small rounding differences in their total. The allowed difference is 0.005 per candidate, capped at 0.05, with a floating-point epsilon. Individual values must still be between zero and one, every requested label must be present, and larger total errors are rejected. Values and confidence are never renormalized or increased. This accommodates the observed 106-option response totalling 0.99.

## Structured yes/no criteria

`noul(instructions, criteria?)` accepts optional descriptions for both outcomes, including structured examples. The existing one-argument call is unchanged. Use independent Noul questions when several tools may be needed; Choice selects one option.

```ts
const attach = TypeSafe.noul(
  { question: "Is dataset attachment needed?", focus: "Classify remaining requested work" },
  {
    true: {
      what: "Attach an existing published dataset",
      not_for: "Importing a new CSV file",
      examples: ["Attach the published invoices dataset"],
    },
    false: { what: "Attachment is unnecessary", examples: ["Import this CSV file"] },
  },
)
```

Both outcome descriptions are validated locally and sent unchanged in structure through the SDK. They guide relevance; argument construction, authorization and execution remain application responsibilities. See [TypeSafe advanced primitives](https://docs.typesafe.ai/primitives/advanced).
