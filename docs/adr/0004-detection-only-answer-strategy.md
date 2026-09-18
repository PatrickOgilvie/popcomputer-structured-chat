# Make TypeSafe detection the only answer strategy for collect stages

ADR 0002 introduced a provider-neutral answer resolver whose first integration
registered finite candidate values for every field. In practice a
question-answering stage asks questions whose answers are not always
enumerable: free text, inferred needs, and open values. A resolver that must
register finite choices for every bound field cannot express those stages, and
it fused detection ("was this question answered?") with value selection, which
forced authors to enumerate values they did not know.

Replace the resolver with detection. `Stage.collect` accepts an optional
`detector`; `TypeSafe.detection` asks one batched Noul per question and returns
`Detected` or `Undetected` per field. Detection is authoritative for which
fields the ordinary generative extraction may fill this turn, and when no field
is detected the stage does not call the model at all and asks its pending
question. Values are never produced by the detector: the existing generative
extraction supplies them and every existing acceptance rule still applies. The
resolver contract, `TypeSafe.collection`, the `resolver` option, and their
exports are removed.

The generative-only path remains for stages without a detector. TypeSafe is
still an optional peer and the package root remains independent of the SDK, so
a structured chat can be built and run without any TypeSafe dependency.
