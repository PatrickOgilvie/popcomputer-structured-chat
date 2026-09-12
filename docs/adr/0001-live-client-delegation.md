# Keep voice observations, workflow commits, and delivery separate

Use client delegation with ordinary Effect actions, retaining the existing structured-chat model and tool authority. Persist observed-speech provenance separately from application submissions: transcript text can ground an answer, but cannot establish an issued question or explicit confirmation, because provider acknowledgements do not prove playback.

Back the Live journal and exclusive workflow owner with the existing atomic session-store interface, in a dedicated namespace. The workflow commit, journal update, and provider append are separate operations; a failure retains ownership for reconciliation, and ambiguous speech delivery is never automatically retried. This deliberately sacrifices automatic reconnect/failover rather than pretending that a revision check, expired lease, or append correlation ID guarantees exactly-once application effects.
