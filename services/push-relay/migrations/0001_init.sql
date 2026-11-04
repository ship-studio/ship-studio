-- An installation is one Mac. Only the SHA-256 of its secret is kept.
CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A phone registered by an installation, under an opaque handle the Mac
-- chose. The push token is the one thing here a provider needs.
CREATE TABLE devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'development')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, ref)
);

-- Fixed-window counters. Keys are opaque ids, never addresses.
CREATE TABLE rate (
  key TEXT PRIMARY KEY,
  win INTEGER NOT NULL,
  count INTEGER NOT NULL
);
