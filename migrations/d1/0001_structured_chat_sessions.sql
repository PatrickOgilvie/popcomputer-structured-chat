-- One structured chat session snapshot per full identity tuple.
CREATE TABLE IF NOT EXISTS structured_chat_sessions (
  namespace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chat TEXT NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL,
  messages TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, session_id, chat, version)
);
