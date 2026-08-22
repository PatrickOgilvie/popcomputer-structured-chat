declare global {
  namespace Cloudflare {
    interface Env {
      readonly SESSIONS_DB: D1Database
      readonly TEST_MIGRATIONS: ReadonlyArray<{
        readonly name: string
        readonly queries: ReadonlyArray<string>
      }>
    }
  }
}

export {}
