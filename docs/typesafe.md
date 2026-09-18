# TypeSafe detection and guided extraction

Install the optional `@typesafe-ai/sdk` peer and import the server-side adapter:

```ts
import { Effect } from "effect"
import { Stage } from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"
```

The package root does not load the SDK. Supply credentials, retry policy, deadlines, and the provider model through `TypeSafe.layer` at the server composition root.

## Compose a detector

Define fields once using `Answer.semantic`, `Answer.explicit`, or `Answer.confirmed`. A detector assesses every eligible field against the incoming user message, including questions that have not been asked yet. One opening message can answer several fields.

```ts
const direct = TypeSafe.detectionPolicy({
  detectedAtOrAbove: 0.9,
  undetectedAtOrBelow: 0.1,
})

const Brief = Stage.collect({
  name: "brief",
  fields,
  detector: TypeSafe.detection(fields, {
    policy: direct,
    overrides: {
      need: {
        policy: TypeSafe.detectionPolicy({
          detectedAtOrAbove: 0.8,
          undetectedAtOrBelow: 0.2,
        }),
        criteria: {
          true: "The message identifies the work the agency should do.",
          false: "The message supplies no agency need.",
        },
      },
    },
  }),
})
```

These thresholds illustrate the API; calibrate them against representative application data. Policies validate `0 <= undetectedAtOrBelow < detectedAtOrAbove <= 1`. The boundaries are inclusive. Field overrides are optional and restricted to the bound field registry. Policies and rubrics are snapshotted at definition time.

One request batches a Noul for each eligible field. The core receives three provider-independent outcomes:

| Outcome | Collection behavior |
| --- | --- |
| `Detected` | Ask the LLM to extract a value; null remains valid if evidence is insufficient. |
| `Uncertain` | Let the LLM assess whether the input answers the field, then extract if supported. |
| `Undetected` | Exclude the field from extraction and preserve any previously accepted value, unless an eligible reply is resolving a pending clarification. |

`Stage.detector(fields, detect)` remains the custom detector seam. Its typed errors and Effect requirements propagate through the stage and chat. Results are parsed and must contain exactly one decision for each offered field. The detector never supplies accepted values or authors evidence.

## The extraction handoff

Detected and uncertain fields share one generative request. The `submit_answers` schema contains only those answer fields and restricts evidence to their names. Extra fields are rejected before acceptance, including during the bounded output-repair attempt. Parsed proposals are normalized before existing post-call guards run.

The model receives a labelled extraction plan containing:

- selected field descriptions, assessment categories, grounding modes, and current evidence indices;
- latest issued question wording and ordered options, plus static choice/value mappings;
- accepted values encoded through their field schemas, with their evidence;
- pending clarification fields and question descriptions, with clarifications taking priority over other missing fields;
- the most recent six conversation messages, preserving source, role, and original transcript index;
- optional application context.

Conversation, accepted values, and application context remain untrusted data, separate from application-authored instructions. Large serialized plans are split into labelled JSON parts below the model message-size limit; content is not silently truncated. References that cannot be resolved from the provided context must remain unresolved. The full original conversation remains available to guards, evidence validation, persistence, and subsequent tool stages.

An accepted value requires successful extraction, schema parsing, grounding, and validation. Acceptance accumulates across turns; a later grounded correction can replace an answer while collection is active. Confirmed fields require an issued question followed by a submitted answer. Observed speech cannot confirm them. The first issuance retains confirmation authority while subsequent question wording and options are recorded separately.

Repeated accepted values retain their existing evidence. Invalid values or evidence are recovered per field, with at most two extraction requests in one collection operation. Valid proposals survive an exhausted model repair. Unresolved answers or corrections lead to clarification; a pending correction retains its previous value but blocks stage completion. An eligible clarification reply reaches the LLM even when detection reports `Undetected`. Application validator and infrastructure failures still reject the turn without changing the persisted session. See [collection proposal recovery](collect-proposal-recovery.md).

The core selects the next clarification or missing question after merging values. The model may suggest adaptive wording, but cannot choose a different pending field. When no field needs extraction, collection uses the trusted pending question without calling the model. An exact uncertainty escape bypasses detection and retains its application-owned resolution and follow-up behavior.

## Enrich context through a typed capability

```ts
const context = Stage.extractionContext(fields, ({ accepted, extracting }) =>
  Effect.succeed({
    budgetCurrency: "GBP",
    fieldsBeingExtracted: extracting,
    previousBudget: accepted.budget?.value ?? null,
  }),
)

const EnrichedBrief = Stage.collect({
  name: "enriched_brief",
  fields,
  context,
  detector: TypeSafe.detection(fields, { policy: direct }),
})
```

The callback receives typed accepted answers, selected field keys, and source-bearing conversation messages. It may use application Effect services. Its expected failures and service requirements propagate through `Stage.collect` and `Chat`. The stage checks that context and detector capabilities are bound to its exact field object.

The result must be JSON-compatible and serialize to at most 20,000 JavaScript string units. Invalid results fail with `Stage.InvalidExtractionContext` and bounded reason codes. Context runs only when making a generative request, including detector budget fallbacks and uncertainty escapes. It also works without a detector, in which case eligible fields are offered to extraction as uncertain. Context does not change eligibility, schemas, or acceptance policy.

## Budgets, failures, and sessions

Detection uses the latest user message's whole trimmed text, up to 2,000 characters. Confirmed fields are offered only for eligible submissions after issuance. Latest issued wording and options accompany each Noul. Larger evidence or evaluator question/state budgets bypass detection and use the labelled extraction path with uncertain decisions.

Provider failures and malformed responses propagate as typed errors. They do not become uncertainty. The adapter retries only transient failures, with 1–3 total attempts within the configured deadline; interruption aborts the request or retry wait. SDK retries and logging remain disabled.

Pre-model guards receive the original conversation; post-call guards receive the original conversation and normalized proposal. Validators, evidence checks, optimistic commits, and exact observed-batch replay retain their existing roles. Failure before commit does not persist a partial turn. Traces add decision counts without adding raw extraction context to telemetry; existing debug/session facilities retain their conversation data.

The [compiled example](../examples/typesafe.ts) demonstrates reusable policies and independent context enrichment. Transport and workflow tests use the real SDK with injected fetch responses in Bun, Node, and workerd, plus D1 persistence tests. They establish contracts, not live Jev accuracy, latency, or cost.

## Reuse judgments directly

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

Detection happens before the existing optimistic session commit. Provider failure does not persist a partial turn. Concurrent calls may both evaluate, but only the writer with the current revision can commit. Replaying an already-applied observed batch through `Chat.advance` skips inference and writes. Ordinary submitted turns retain their existing semantics and are not deduplicated by this adapter.

The suite exercises the real SDK with deterministic injected fetch responses in Bun, Node ESM, and Cloudflare workerd, plus real D1 persistence, observed replay, and conflicting commits. These tests establish transport and workflow contracts; they do not measure live model quality, production latency, or cost. Run a representative labeled evaluation before enabling detection for production traffic.

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
