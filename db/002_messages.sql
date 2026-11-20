BEGIN;

CREATE TABLE IF NOT EXISTS messages (
    chat_id uuid NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    id text COLLATE "C" NOT NULL CHECK (id ~ '^[A-Za-z0-9]{20}$'),
    sender_id text COLLATE "C" NOT NULL REFERENCES users (id),
    -- Keep JSON escapes that PostgreSQL text cannot represent, such as U+0000.
    body json NOT NULL CHECK (json_typeof(body) = 'string'),
    sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (chat_id, id)
);

CREATE INDEX IF NOT EXISTS messages_timeline_idx ON messages (chat_id, sent_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_read_receipts (
    chat_id uuid NOT NULL,
    message_id text COLLATE "C" NOT NULL,
    user_id text COLLATE "C" NOT NULL REFERENCES users (id),
    read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (chat_id, message_id, user_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES messages (chat_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_last_seen (
    chat_id uuid NOT NULL,
    user_id text COLLATE "C" NOT NULL REFERENCES users (id),
    message_id text COLLATE "C" NOT NULL,
    message_sent_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES messages (chat_id, id) ON DELETE CASCADE
);

COMMIT;
