import pg from "pg";

import { HttpError } from "./errors.js";

export function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => console.error("PostgreSQL pool error", error));
  return pool;
}

interface ChatRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
}

interface Chat {
  chatId: string;
  memberIds: [string, string];
}

function toChat(row: ChatRow): Chat {
  return { chatId: row.id, memberIds: [row.user_a_id, row.user_b_id] };
}

export class ChatRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createOrGet(userAId: string, userBId: string): Promise<string> {
    if (userAId === userBId) {
      throw new HttpError(400, "A chat requires two distinct users");
    }

    const pair = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO chats (user_a_id, user_b_id)
       SELECT a.id, b.id FROM users a CROSS JOIN users b
       WHERE a.id = $1 AND b.id = $2
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING
       RETURNING id`,
      pair,
    );
    if (inserted.rows[0]) {
      return inserted.rows[0].id;
    }

    // A separate statement can see a conflicting chat committed by a concurrent request.
    const existing = await this.pool.query<{ id: string }>(
      "SELECT id FROM chats WHERE user_a_id = $1 AND user_b_id = $2",
      pair,
    );
    if (!existing.rows[0]) {
      throw new HttpError(404, "One or both users were not found");
    }
    return existing.rows[0].id;
  }

  async get(chatId: string): Promise<Chat> {
    const { rows: [row] } = await this.pool.query<ChatRow>(
      "SELECT id, user_a_id, user_b_id FROM chats WHERE id = $1",
      [chatId],
    );
    if (!row) {
      throw new HttpError(404, "Chat not found");
    }
    return toChat(row);
  }

  async listForUser(userId: string): Promise<Chat[]> {
    const { rows } = await this.pool.query<ChatRow>(
      `SELECT id, user_a_id, user_b_id FROM chats
       WHERE user_a_id = $1 OR user_b_id = $1
       ORDER BY created_at DESC, id`,
      [userId],
    );
    return rows.map(toChat);
  }
}
