BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$')
);

CREATE TABLE IF NOT EXISTS chats (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a_id text COLLATE "C" NOT NULL REFERENCES users (id),
    user_b_id text COLLATE "C" NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chats_canonical_pair CHECK (user_a_id < user_b_id),
    CONSTRAINT chats_unique_pair UNIQUE (user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS chats_user_b_idx ON chats (user_b_id);

COMMIT;
