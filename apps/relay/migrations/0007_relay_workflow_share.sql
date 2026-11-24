CREATE TABLE relay_workflow_share (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  package BLOB NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX relay_workflow_share_owner ON relay_workflow_share(user_id, expires_at);
