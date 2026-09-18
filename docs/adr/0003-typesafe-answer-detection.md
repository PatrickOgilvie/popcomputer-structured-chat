# Detect answered questions before generative extraction

A collect stage is an interactive form that should not feel like one. One user
message may answer none, one, or several of its questions, and the system must
not re-ask what the user already said. The generative model previously made
that decision implicitly while also extracting values, which made "which
questions were answered" a side effect of an open-ended generation.

Add an optional `detector` to `Stage.collect`, mutually exclusive with the
finite `resolver`. A detector receives the core-owned evidence (the latest
user message, trimmed, up to 2,000 characters) and returns `Detected` or
`Undetected` for every groundable field. Detected fields are authoritative:
only they may be filled by the ordinary generative extraction this turn, and
the existing schema checks, evidence checks, guards, validators, corrections,
and session revision rules still decide acceptance. When no field is detected,
the stage does not call the model and asks its trusted pending question.

The first integration is `TypeSafe.detection`, which asks one Noul per field in
a single batched request: "does this evidence answer this question?" This works
for fields without finite choices, where a candidate-based resolver cannot
apply, and returns calibrated probabilities for per-field thresholds.

Out-of-bound evidence and question-count or state budgets fall back to the
ordinary generative path. Provider failures and malformed responses propagate
as typed errors rather than silently switching strategy. Detection considers
only the latest user message; broader evidence search and per-field value
selection from the detector are deferred.
