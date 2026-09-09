-- One active snapshot or terminal expiry tombstone per full identity tuple.
CREATE TABLE IF NOT EXISTS structured_chat_sessions (
  namespace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chat TEXT NOT NULL,
  version INTEGER NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'expired')),
  revision INTEGER,
  state TEXT,
  messages TEXT,
  updated_at INTEGER,
  expired_at INTEGER,
  PRIMARY KEY (namespace, session_id, chat, version),
  CHECK (
    (lifecycle = 'active' AND revision IS NOT NULL AND revision > 0
      AND state IS NOT NULL AND messages IS NOT NULL AND updated_at IS NOT NULL AND expired_at IS NULL)
    OR
    (lifecycle = 'expired' AND revision IS NULL AND state IS NULL
      AND messages IS NULL AND updated_at IS NULL AND expired_at IS NOT NULL)
  )
);
