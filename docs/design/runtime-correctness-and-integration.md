# Structured Chat Runtime Correctness and Integration

## Summary

This specification evaluates six architecture changes discovered while
integrating `@popcomputer/structured-chat` into the DCA matchmaker. Five are
accepted in narrowed forms that improve correctness or remove duplicated
ownership. One is deliberately parked until a concrete caller needs it.

| Change | Decision | Reason |
| --- | --- | --- |
| Seal package definitions | Accept, narrowed | Structural tuple constraints currently permit incomplete definitions that the runtime treats as package-created |
| Validate semantic chat state | Accept | Persisted snapshots can satisfy field schemas while representing impossible workflow history |
| Share model planning | Accept | Two security-sensitive model-call pipelines currently duplicate the same ordering and policy |
| Tag context provenance | Park | Useful for source-aware guards and compaction, but currently adds persistence and provider complexity without a proven caller |
| Use Drizzle in the D1 adapter | Accept | The app currently has separate Drizzle and raw-SQL owners for the same table |
| Project DCA view inputs | Accept, narrowed | DCA currently constructs versioned parts, removes their version, and asks the package to reconstruct them |

## Implementation Status

The five accepted changes are implemented. Package verification covers strict
TypeScript, type-level rejection of forged definitions, semantic state
validation, the shared guarded planner, all behavioural tests, the production
build, and Node ESM loading. The DCA integration additionally passes its full
application test suite, production build, and a real Miniflare/D1 optimistic
concurrency test. Tagged context provenance remains intentionally unimplemented
until one of the activation conditions below is met.

The public workflow definition remains intentionally small:

```ts
const SearchCatalog = defineTool({
  name: "search_catalog_case_studies",
  description: "Find relevant published case studies.",
  input: CatalogSearchInput,
  execute: searchCatalog,
}).pipe(
  Tool.modelResult(CatalogEvidence, toModelEvidence),
  Tool.present(AgencyCards, toAgencyCards),
)

const Matchmaker = defineChat({
  name: "agency_matchmaker",
  version: 1,
  stages: [ProjectBrief, CatalogMatching],
})
```

None of the accepted package changes adds a required end-user option.

## Context / Current State

The package derives model tools, runtime parsing, typed Effect requirements,
server-owned state, optimistic session persistence, and browser views from
schema-defined tools and stages.

Three internal assumptions are currently wider than their proofs:

1. `ChatStageTuple`, `ToolTuple`, and `ModelGuardTuple` accept public structural
   minimum shapes. Their consumers cast those values to private runtime shapes.
2. the generated chat-state schema validates individual fields but not the
   relationship between stage position, lifecycle, and collect-stage progress;
3. `runToolStep` and `ToolStage.plan` separately implement the same guarded
   model-planning sequence.

The DCA integration also exposes two application seams with duplicate owners:

1. `structured_chat_sessions` is defined in Drizzle but queried through
   separately maintained raw SQL;
2. DCA presenters construct complete versioned data parts even though
   `defineView` and `Tool.present` already own versioning and validation.

Conversation history intentionally treats user text, framework questions, and
retrieved tool evidence as untrusted. It currently stores them all as ordinary
`user | assistant` messages, losing origin information. No current caller uses
origin-specific policy, so changing this persisted contract now would be
speculative.

## Goals

- Make constructor-created definitions the only values accepted by package
  registries without changing normal end-user code.
- Reject persisted state that could not have been produced by legal chat
  transitions.
- Give every model-authored tool proposal one authoritative guard, request,
  parse, and post-parse pipeline.
- Make the DCA Drizzle table the source of truth for D1 queries and writes.
- Make DCA presenters return exactly the unversioned view input requested by
  `Tool.present`.
- Preserve typed Effect errors, requirements, interruption, optimistic
  concurrency, safe spans, and strict boundary parsing.

## Non-Goals

- Arbitrary workflow graphs, branching sessions, or cyclic agent execution.
- A universal session identity or authentication policy.
- A package-provided D1 adapter; D1 remains application-owned infrastructure.
- A history migration or backwards-compatibility layer.
- Source-aware context compaction before a real caller requires it.
- A monolithic runtime module containing tool, stage, guard, state, and
  persistence behaviour.
- Changing the existing tool, stage, chat, or view definition DX.

## Invariants

1. Tools, stages, and guards accepted by registries were created by package
   constructors.
2. Type erasure remains local and is restored only after the package-owned
   runtime identity has been established.
3. A persisted active state points to the only stage that may legally run.
4. Normally, every collect stage before the active stage is complete and every
   stage after it is initial. Opt-in repair may instead retain later completed
   stages behind an explicit ordered reconfirmation queue.
5. A complete state exists only at a terminal tool stage configured with
   `afterExecution: "complete"`.
6. Confirmed answers cannot exist unless their evidence follows the message at
   which the server issued that field's question.
7. Asked-field cursors contain registered field names and bounded message
   indexes.
8. Pre-model guards run before the provider; post-parse guards run after strict
   call parsing and before application execution.
9. `plan` never executes application tool code.
10. Optimistic D1 replacement applies only at the expected revision.
11. A view schema version is introduced exactly once by `defineView`.
12. Model-visible tool results remain bounded and untrusted.

## Design Constraints

- Effect Schema remains the runtime parser and refinement mechanism.
- Effect Services, Layers, and typed errors remain the dependency and failure
  model.
- The package has no required React, assistant-ui, database, or Cloudflare
  runtime dependency.
- DCA owns authentication, actor/session namespacing, database selection, and
  UI presentation policy.
- Definition errors are startup defects; model, persistence, and projection
  failures remain typed expected failures.
- Existing spans remain safe and content-free.
- No compatibility machinery is added for pre-release persisted sessions.

## Alternatives Considered

### Definition authenticity

#### Option 1: Keep structural shapes and add runtime property checks

This catches some JavaScript misuse but leaves TypeScript accepting values the
runtime cannot execute. Every consumer must repeat the checks.

#### Option 2: One shared package-owned definition brand

A private symbol carries the definition kind (`tool`, `collect_stage`,
`tool_stage`, or `model_guard`). Constructors attach it and registries require
it. Runtime readers stay local to the modules that own the behaviour.

This is recommended.

#### Option 3: Move every runtime implementation into one core object

This localises casts but couples unrelated tool, stage, guard, and persistence
behaviour. It would be a large module with little additional caller leverage.

This is rejected. The runtime identity is shared; cohesive implementations
remain with their owning modules.

### Persisted state

#### Option 1: Replace the persistence DTO with a deeply tagged union

This gives the strongest static lifecycle representation but makes generated
stage-index types, persistence adapters, and lower-level `run` callers more
complex without improving the normal `defineChat` DX.

#### Option 2: Preserve the compact DTO and add a generated semantic refinement

The package keeps `{ stage, status, stages }`, but its generated schema checks
the cross-field lifecycle using the compiled stage definitions. This is
recommended because state is package-owned and callers normally never
construct it.

#### Option 3: Trust the store because it is server-owned

Persistence is still an unknown boundary. Adapter bugs, stale values, and data
corruption must not become valid domain history. This is rejected.

### Model planning

#### Option 1: Leave direct and stage planning separate

This preserves duplication and makes security ordering vulnerable to drift.

#### Option 2: One internal `planToolCall` operation

The operation owns both guard phases, provider invocation, and strict parsing.
Direct execution and tool stages compose it differently. This is recommended.

#### Option 3: Expose a new public planner service

There is no second implementation or caller-owned variation. A public service
would increase interface burden without creating a meaningful seam. Rejected.

### Context provenance

#### Option 1: Keep `UntrustedMessage`

All context remains uniformly untrusted and the current provider/session
contract stays small. This remains the selected design for now.

#### Option 2: Persist tagged context events

```ts
type ChatContextEvent =
  | { readonly _tag: "UserText"; readonly content: string }
  | { readonly _tag: "FrameworkQuestion"; readonly content: string }
  | {
      readonly _tag: "ToolEvidence"
      readonly tool: string
      readonly content: string
    }
```

This becomes preferable when a production guard, compactor, evaluator, or
provider projection needs origin-specific behaviour. Until then it would add a
second context model and a persisted-protocol change with no exercised payoff.

#### Option 3: Mark framework/tool content as trusted instructions

Retrieved or model-derived content must never become trusted merely because
the server stored it. Rejected.

### D1 persistence

#### Option 1: Keep raw D1 SQL

Optimistic writes are expressible, but table and column ownership remain
duplicated beside the Drizzle schema.

#### Option 2: Use the existing typed Drizzle D1 database

Select, insert, and guarded update use `structuredChatSessions`; affected-row
metadata remains parsed at the D1 boundary. This is recommended.

#### Option 3: Move a D1 adapter into the package

This would add Cloudflare and Drizzle decisions to a storage-neutral package.
Rejected at design time.

> Amended 2026-08: a D1 adapter shipped as the optional `@popcomputer/
> structured-chat/d1` entry point. The core remains storage-neutral and the
> adapter stays out of the default dependency graph, which preserves this
> decision's intent; the letter of the rejection ("no D1 adapter in the
> package") no longer holds. The shipped adapter uses raw parameterized SQL
> with strictly parsed rows rather than Drizzle, so Option 2's coupling
> concern does not apply to it.

### View projection

#### Option 1: Continue returning complete data parts

This requires removing `schemaVersion` before passing data to `Tool.present`,
so package and application both own the same protocol wrapper.

#### Option 2: Return `ViewInput<View>` from application presenters

`Tool.present` becomes the only place that wraps and validates the part. This
is recommended.

#### Option 3: Add shared presenter caches or a package presentation graph

DCA projections are small and deterministic. Caching or a new package feature
would add hidden state or speculative abstraction. Rejected.

## Recommendation

Implement the five accepted changes in this order:

1. seal definitions with a small package-owned runtime identity;
2. use the now-authentic stage definitions to refine persisted state;
3. consolidate model planning;
4. convert DCA view presenters to view-input projections;
5. convert the D1 adapter to the existing Drizzle database.

Park tagged context provenance until at least one real caller requires
source-aware policy or compaction. Actor/session namespacing remains
application-owned because authentication semantics vary by application.

## Proposed Design

### 1. Package-owned definition identity

An internal module owns a non-public symbol and kind union:

```ts
type StructuredDefinitionKind =
  | "tool"
  | "collect_stage"
  | "tool_stage"
  | "model_guard"

interface StructuredDefinition<Kind extends StructuredDefinitionKind> {
  readonly [structuredDefinitionKind]: Kind
}

function structuredDefinition<Kind extends StructuredDefinitionKind>(
  kind: Kind,
): <Definition extends object>(
  definition: Definition,
) => Definition & StructuredDefinition<Kind>
```

`ToolDefinitionContract`, stage definition contracts, and guard definition contracts
extend the appropriate branded contract. Constructors attach the brand.
Registries no longer claim that a public `_tag` alone proves authenticity.

The symbol is internal and is not exported from the package root.

### 2. Generated semantic state parser

Every collect-stage runtime exposes pure predicates needed by `defineChat`:

```ts
interface RuntimeCollectStage {
  readonly initialState: unknown
  readonly stateSchema: Schema.Schema.AnyNoContext
  readonly isInitial: (state: unknown) => boolean
  readonly isComplete: (state: unknown) => boolean
  readonly isValid: (state: unknown) => boolean
  // existing run contract
}
```

The public `CollectStage` may expose `isInitial` and `isValid` only if callers
gain a coherent state-domain operation. Otherwise these predicates remain in
the internal runtime descriptor.

The generated chat-state schema applies a semantic filter after field parsing:

```ts
const isValidChatState = (state: RuntimeChatState): boolean => {
  // all collect states are locally valid
  // stages before the cursor are complete
  // a collect stage at the cursor is incomplete
  // stages after the cursor are initial
  // complete is legal only at a terminal final query or command stage
}
```

Failure continues to cross the public persistence boundary as
`InvalidChatSession({ reason: "invalid_snapshot" })`.

### 3. Shared guarded planner

```ts
interface PlanToolCallInput<
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple,
> {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly tools: ToolSet<Tools>
  readonly guards: Guards
}

function planToolCall<Tools, Guards>(
  input: PlanToolCallInput<Tools, Guards>,
): Effect.Effect<
  ToolSetCall<Tools>,
  ChatModelUnavailable | InvalidToolCall | ModelGuardError<Guards>,
  StructuredChatModel | ModelGuardRequirements<Guards>
>
```

This is internal. `runToolStep` adds `tools.execute`; `ToolStage.plan`
returns it directly; `ToolStage.run` adds execution.

### 4. Parked context-event model

No production contract changes in this slice. The activation criteria are:

- a guard needs to distinguish user text from retrieved evidence;
- a context budget/compactor treats questions and evidence differently;
- a provider adapter needs typed tool-result messages rather than generic text;
- evaluation demonstrates that origin-aware projection improves reliability.

When activated, session events and provider messages must remain distinct
types joined by an explicit projection.

### 5. Drizzle D1 adapter

```ts
export function makeD1ChatSessionStore(
  database: Database,
): ChatSessionStoreService

export function makeD1ChatSessionStoreLayer(
  database: Database,
): Layer.Layer<ChatSessionStore>
```

The adapter owns:

- Drizzle query construction;
- JSON persistence projection;
- JSON and snapshot boundary parsing;
- numeric/string revision projection;
- D1 affected-row parsing;
- typed unavailable/conflict failures.

The composition root converts `env.DB` to `Database` before constructing the
layer. No raw D1 binding enters the service-facing adapter interface.

### 6. DCA view inputs

Application presenters return the exact input schemas:

```ts
type AgencyCardsInput = ViewInput<
  typeof AgencyProjectCaseStudyCarouselView
>

function presentCatalogSearchCarousel(
  execution: CatalogSearchToolExecution,
): Option.Option<AgencyCardsInput>
```

`Tool.present` remains unchanged:

```ts
Tool.present(
  AgencyProjectCaseStudyCarouselView,
  (execution) => Option.getOrUndefined(
    presentCatalogSearchAlternatives(execution),
  ),
)
```

The package injects `schemaVersion`, constructs the data part, and validates
the result once.

## Seams, Boundaries, Adapters, and Implementations

| Seam | Owner | Input | Output/failure |
| --- | --- | --- | --- |
| Definition constructor | Package domain module | typed application definition | opaque executable definition or startup defect |
| Model planner | Package service module | trusted instructions, untrusted messages, closed tool set, guards | parsed call or typed model/guard/call failure |
| Chat-state parser | Package domain module | unknown persisted state | semantically valid state or parse failure |
| Session store | Package interface | parsed scope/replacement | unknown snapshot/replacement or typed store failure |
| D1 store adapter | DCA external adapter | package store commands | parsed snapshot/revision or typed store failure |
| View projector | DCA domain/application module | trusted search execution | optional unversioned display input |
| View constructor | Package protocol module | unversioned display input | validated versioned data part |

Authentication and actor binding remain outside `ChatSessionStore`. The store
receives an already scoped session ID and does not infer authorization.

## Call Stacks and Data Flow

### Current definition flow

```txt
structural object with matching _tag/name
  -> ChatStageTuple / ToolTuple / ModelGuardTuple
  -> unchecked runtime cast
  -> method/property access assumed to exist
```

### Proposed definition flow

```txt
Stage.collect / Stage.tools / defineTool / defineModelGuard
  -> validate definition configuration
  -> attach package-owned kind identity
  -> registry accepts opaque definition
  -> local runtime descriptor executes typed behaviour
```

### Current model flow

```txt
runToolStep OR ToolStage.plan
  -> pre-model guards
  -> StructuredChatModel.requestTool
  -> ToolSet.parseCall
  -> post-parse guards
  -> optional ToolSet.execute
```

The first four operations are duplicated.

### Proposed model flow

```txt
runToolStep / ToolStage.plan
  -> planToolCall
       -> runModelGuards
       -> StructuredChatModel.requestTool
       -> ToolSet.parseCall
       -> runModelCallGuards
       -> parsed ToolSetCall
  -> plan returns call
  OR
  -> run executes ToolSet.execute
```

Effect interruption continues through `requestTool`; adapters continue to
receive the runtime-owned abort signal.

### Current snapshot flow

```txt
store.load -> unknown
  -> ChatSessionSnapshotSchema
  -> generated field-shape state schema
  -> runtime assumes lifecycle consistency
```

### Proposed snapshot flow

```txt
store.load -> unknown
  -> ChatSessionSnapshotSchema
  -> generated field-shape state schema
  -> generated semantic lifecycle refinement
  -> runnable ChatState
```

Any failure becomes `InvalidChatSession("invalid_snapshot")` before model or
tool work begins.

### Proposed D1 flow

```txt
ChatSessionStore.load(scope)
  -> Drizzle select(structuredChatSessions)
  -> inferred storage row
  -> parse JSON state/messages
  -> ChatSessionSnapshotSchema
  -> unknown snapshot returned to package core

ChatSessionStore.replace(input)
  -> encode state/messages JSON
  -> expectedRevision null
       -> Drizzle insert on conflict do nothing
     expectedRevision present
       -> parse numeric revision
       -> Drizzle update WHERE identity AND revision
  -> parse D1 affected-row metadata
  -> replacement revision OR ChatSessionConflict
```

Both insert and update remain single-statement atomic optimistic transitions.
There are no retries and no network calls inside a transaction.

### Proposed view flow

```txt
CatalogSearchToolExecution
  -> DCA projector
  -> Option<ViewInput<View>>
  -> Tool.present
  -> View.parseData
  -> versioned ViewPart
  -> presentChatReply
  -> strict browser response
```

### Observability flow

Existing content-free spans remain at model planning, tool execution, tool-set
parsing, session reply, and guards. DCA retains safe completion/failure logs.
No prompt, message, tool arguments, search evidence, storage JSON, or provider
cause is added to telemetry.

## Files to Add / Change / Delete

### Package

- Add `src/core/definition.ts`: internal definition kind identity and
  constructor helper.
- Change `src/core/tool.ts`: seal tool definitions.
- Change `src/core/tool-set.ts`: accept only sealed tools.
- Change `src/core/model-guard.ts`: seal guards.
- Change `src/core/collect-stage.ts`: seal collect stages and define semantic
  state predicates.
- Change `src/core/stage.ts`: seal tool stages and delegate planning.
- Change `src/core/model.ts`: own the shared internal planner.
- Change `src/core/chat.ts`: accept sealed stages and refine generated state.
- Change `src/index.ts`: remove minimum-shape exports that are not caller APIs.
- Change package type and behaviour tests for definition authenticity,
  planning parity, and invalid persisted states.

### DCA application

- Change `src/matchmaker/d1-chat-session-store.ts`: use `Database`, Drizzle,
  and `structuredChatSessions`.
- Change `src/index.ts`: construct the D1 store layer from `createDb(env.DB)`.
- Change the D1 integration test to exercise the Drizzle-backed adapter.
- Change the three catalogue presentation modules to return view inputs.
- Change `src/matchmaker/matchmaker-structured-chat.ts`: remove version
  stripping and compose optional view inputs directly.
- Change presentation tests to verify projection data and final view wrapping
  through public view contracts.

No production module is deleted solely for architectural symmetry.

## RGR TDD Test Plan

The sibling TDD skill referenced by the tech-spec skill is not installed in
this environment. The following plan applies the repository's existing
Red-Green-Refactor style and behaviour-testing standards directly.

### Slice 1: Definition authenticity

1. Red: type tests show fabricated tools, stages, and guards are rejected.
2. Green: attach the internal kind identity in constructors and constrain
   tuples to it.
3. Refactor: remove obsolete public minimum-shape exports and keep runtime
   casts local.
4. Verify existing end-user examples typecheck unchanged.

### Slice 2: Persisted state semantics

1. Red: `parseState` rejects complete-at-collect-stage, active completed
   collect-stage, incomplete prior stage, mutated future stage, duplicate asked
   fields, and unasked confirmed answers.
2. Green: add local collect predicates and the generated chat refinement.
3. Refactor: share the same semantic parser between `parseState` and `reply`.
4. Verify valid collection, follow-up, terminal, and optimistic persistence
   behaviour through `ChatDefinition`.

### Slice 3: Planning parity

1. Red: a shared behaviour table proves direct planning and stage planning
   both apply pre-guards, strict call parsing, and post-parse guards.
2. Green: introduce `planToolCall` and delegate both paths.
3. Refactor: preserve precise errors/requirements and intentional spans.
4. Verify `plan` does not execute and `run` executes exactly once.

### Slice 4: DCA view inputs

1. Red: application projector tests expect unversioned input data.
2. Green: return `ViewInput<View>` and remove `withoutSchemaVersion`.
3. Refactor: let `View.make`/`Tool.present` be the only part constructors.
4. Verify the structured-chat integration emits the same browser parts.

### Slice 5: Drizzle D1 adapter

1. Red: adapt the real Miniflare D1 integration test to the typed Drizzle
   database.
2. Green: replace raw select/insert/update strings with Drizzle queries.
3. Refactor: keep JSON and affected-row parsing as explicit persistence
   boundary projections.
4. Verify create, load, replace, and stale conflict using the real migration.

### Final verification

- Package strict TypeScript and public type tests.
- Package examples.
- Package behavioural tests and Node ESM smoke test.
- DCA TypeScript check.
- DCA focused structured-chat, presentation, adapter, action, and UI tests.
- DCA production build.
- Miniflare D1 integration test as part of the normal test command.

## Risks and Open Questions

- Effect Schema filters must preserve useful parse failures without exposing
  persisted content.
- Definition branding must survive tool combinators that rebuild tools by
  spreading their runtime definition.
- Drizzle's D1 result still crosses a platform boundary; affected-row metadata
  must remain parsed rather than trusted from its TypeScript declaration.
- The DCA architecture document predates structured-chat, claims D1 session
  state is pending, and names superseded Honertia/document-graph packages. It
  should be replaced with concise current architecture rather than extended.
- Context provenance remains parked. Revisit it only when one activation
  criterion has a production caller and tests can prove the benefit.
