# TypeSafe judgments and guided planning

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

Provider failures and malformed responses propagate as typed errors by default. Detection and selection can explicitly hand off transient unavailability to the model with `onUnavailable: "fallback"` (see below). The adapter retries only transient failures, with 1–3 total attempts within the configured deadline; interruption aborts the request or retry wait. SDK retries and logging remain disabled.

Pre-model guards receive the original conversation; post-call guards receive the original conversation and normalized proposal. Validators, evidence checks, optimistic commits, and exact observed-batch replay retain their existing roles. Failure before commit does not persist a partial turn. Traces add decision counts without adding raw extraction context to telemetry; existing debug/session facilities retain their conversation data.

The [compiled example](../examples/typesafe.ts) demonstrates reusable policies and independent context enrichment. Transport and workflow tests use the real SDK with injected fetch responses in Bun, Node, and workerd, plus D1 persistence tests. They establish contracts, not live Jev accuracy, latency, or cost.

## Select tools with Jev

Selection is optional on `Stage.tools`, independently of answer detection. It
chooses an action; it does not construct arguments or authorize execution.

```ts
const tools = [searchAgencies, searchCaseStudies, compareAgencies] as const

const search = Stage.tools({
  name: "search",
  tools,
  instructions: [
    "On entering this stage, find agencies matching the accepted brief.",
    "On later replies, choose the requested action.",
  ],
  selection: TypeSafe.selection(tools, {
    policy: TypeSafe.selectionPolicy({
      minimumProbability: 0.9,
      minimumMargin: 0.15,
    }),
    criteria: {
      search_agencies: "Find agencies matching the accepted brief.",
      search_case_studies: "Find examples of previous work.",
      compare_agencies: "Compare agencies already identified.",
    },
  }),
  inputs: Stage.toolInputs(tools, {
    // These tools read accepted answers through Tool.Context themselves.
    search_agencies: () => Effect.succeed({}),
    search_case_studies: () => Effect.succeed({}),
  }),
  clarification: Question.adaptive("Ask for the action or details needed.", {
    fallback: "Would you like agencies, example projects, or a comparison?",
  }),
})
```

Import `Question` and `Tool` from the package root when using them. Tool names in
criteria and input bindings are checked against the tuple. Rubrics default to
tool descriptions. Bindings return each tool's **decoded** input, preserving
codecs such as `Schema.DateFromString`; only the selected binding runs.

Supply both `TypeSafe.layer(...)` and the existing default or named model layer.
The model remains required for fallback, even when a particular turn needs no
generative request. The selector, bindings and tool implementations retain their
typed errors and required Effect services through the stage and chat.

| Selection | Behaviour |
| --- | --- |
| Selected tool with an input binding | Encode, parse and guard the application input; execute without the LLM. |
| Selected tool without a binding | Ask the LLM for that tool's arguments or a clarification. |
| Selected conversation repair | Ask the LLM for grounded corrections through the existing repair schema. |
| Uncertain or not applicable | Offer all available actions to the LLM, including clarification and any enabled repair. |
| No match | Ask the configured fixed question or adaptive fallback without executing. |

One Choice evaluation includes explicit no-match and uncertainty options. The
policy compares the highest **probability** and its margin over the runner-up;
the provider's separate `confidence` is diagnostic. Ties abstain. These example
thresholds need calibration against representative requests.

The selector receives the stage purpose, transition trigger, encoded accepted
answers and conversation. It does not silently truncate history. Its candidate
limit defaults to 32, including repair and abstention options; configure
`maximumCandidates` to change that bound. Oversized context uses the configured
TypeSafe state limit and returns `NotApplicable` without a provider request.
Provider errors remain typed failures unless transient unavailability is explicitly configured to fall back.

`Stage.toolSelector(tools, decide)` is the provider-neutral composition seam:

```ts
const jev = TypeSafe.selection(tools, { policy })
const selection = Stage.toolSelector(tools, context =>
  shouldSearchImmediately(context)
    ? Effect.succeed({
        _tag: "Selected",
        target: { _tag: "Tool", name: "search_agencies" },
      })
    : jev.select(context),
)
```

Its outcomes are `Selected`, `Uncertain`, `NoMatch`, and `NotApplicable`. Selected
targets are `{ _tag: "Tool", name }` or `{ _tag: "Repair" }`. Core parses the
result and rejects targets not offered in that planning pass. A repair target is
available only through an enabled `Repair.standard()` policy.

Selection-enabled `stage.plan(messages, frame?)` returns `Call` or
`Clarification`; `stage.run(...)` returns `Executed` or `Clarification`. The
optional standalone frame supplies a trigger and encoded accepted answers;
`Chat.turn` supplies it automatically. Unconfigured stages keep their existing
method results.

A chat clarification is a `Clarification` turn with `clarification.text`. It
preserves accepted answers and the active stage, persists authored wording, and
renders as ordinary assistant text. It is not a collected-answer question.
Adaptive wording comes from an already-needed model request, with no extra call
for phrasing. Invalid proposals receive at most one output-repair request before
clarifying. Guard, provider, resolver and execution failures still fail the turn.

Input bindings always pass their tool's codec and call guards. During fallback,
the model sees an empty argument schema for bound tools and cannot override their
inputs. Ordinary nested conversation routing continues into the stage planner.
Explicit `Message.hint` calls retain their existing path: their complete arguments
are already bound by the application, take precedence over general stage input
bindings, and still pass the tool parser and execution guards. A selector does not
replace an accepted, application-authored reply hint.

This capability currently applies to query-tool stages. Command and interaction
stages retain their existing planning and admission behaviour.

## Disable Jev or recover from an outage

Detection and selection each accept the same explicit availability policy:

```ts
const detector = TypeSafe.detection(fields, {
  policy: detectionPolicy,
  onUnavailable: "fallback",
})
const selection = TypeSafe.selection(tools, {
  policy: selectionPolicy,
  onUnavailable: "fallback",
})
```

`onUnavailable` defaults to `"fail"`. With `"fallback"`, a network failure,
timeout, rate limit, overloaded service or server error hands off after the
adapter's bounded retries or total deadline. The result is
`NotApplicable` with `reason: "provider_unavailable"`; no probabilities or
negative judgments are invented. Detection offers every eligible field to the
LLM as uncertain, so it assesses presence and extracts grounded values in the
same request. Selection offers the available actions and clarification control
to the LLM. Application input bindings, guards and validation still apply.

The trace records a `TypeSafeFallback` event with the operation and bounded
failure reason. Authentication, configuration, invalid requests and malformed
responses remain errors. Cancellation still interrupts the turn; it never
starts a fallback request. An unavailable LLM still fails through its existing
typed error channel. Direct `TypeSafe.Service.evaluate` calls retain their
existing failure contract because they do not own an LLM handoff.

To disable Jev deliberately, omit the collect stage's `detector`. For a tool
stage that should retain bindings and clarification, use a selector that hands
off immediately:

```ts
const search = Stage.tools({
  name: "search",
  tools,
  instructions: ["Choose the requested agency action."],
  selection: Stage.toolSelector(tools, () =>
    Effect.succeed({ _tag: "NotApplicable", reason: "disabled" }),
  ),
  inputs, // The same application bindings used with Jev.
})
```

This selector does not require `TypeSafe.Service` or make a Jev request. It uses
the same labelled planning context and LLM fallback path as an outage. Keep the
model layer configured for both deliberate bypass and availability fallback.

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
