import { DurableObject } from "cloudflare:workers"

/** Test composition root; the driver receives this object's real SQLite storage. */
export class SqliteStorageProbe extends DurableObject {}

export default { fetch: () => new Response("SQLite test worker") }
