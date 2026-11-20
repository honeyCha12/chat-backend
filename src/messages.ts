import { randomInt } from "node:crypto";

import type pg from "pg";

import { HttpError } from "./errors.js";

interface ReadReceipt {
  userId: string;
  readAt: string;
}

interface Message {
  messageId: string;
  senderId: string;
  text: string;
  timestamp: string;
  readReceipts: ReadReceipt[];
}

const messageIdCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const timestampFormat = 'YYYY-MM-DD"T"HH24:MI:SS.US"000Z"';

export class MessageRepository {
  constructor(private readonly pool: pg.Pool) {}

  async send(chatId: string, senderId: string, text: string): Promise<string> {
    const id = Array.from({ length: 20 }, () => {
      return messageIdCharacters.charAt(randomInt(messageIdCharacters.length));
    }).join("");
    await this.pool.query(
      "INSERT INTO messages (chat_id, id, sender_id, body) VALUES ($1, $2, $3, $4)",
      [chatId, id, senderId, JSON.stringify(text)],
    );
    return id;
  }

  async list(chatId: string, limit: number): Promise<Message[]> {
    const { rows } = await this.pool.query<Message>(
      `SELECT message.id AS "messageId", message.sender_id AS "senderId", message.body AS text,
              to_char(message.sent_at AT TIME ZONE 'UTC', $3) AS timestamp,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'userId', receipt.user_id,
                  'readAt', to_char(receipt.read_at AT TIME ZONE 'UTC', $3)
                ) ORDER BY receipt.user_id)
                FROM message_read_receipts AS receipt
                WHERE receipt.chat_id = message.chat_id AND receipt.message_id = message.id
              ), '[]'::json) AS "readReceipts"
       FROM (
         SELECT chat_id, id, sender_id, body, sent_at
         FROM messages
         WHERE chat_id = $1
         ORDER BY sent_at DESC, id DESC
         LIMIT $2
       ) AS message
       ORDER BY message.sent_at, message.id`,
      [chatId, limit, timestampFormat],
    );
    return rows;
  }

  async markRead(chatId: string, messageId: string, userId: string): Promise<void> {
    const { rows: [result] } = await this.pool.query<{ found: boolean }>(
      `WITH target AS (
         SELECT chat_id, id FROM messages WHERE chat_id = $1 AND id = $2
       ), recorded AS (
         INSERT INTO message_read_receipts (chat_id, message_id, user_id)
         SELECT chat_id, id, $3 FROM target
         ON CONFLICT (chat_id, message_id, user_id) DO NOTHING
       )
       SELECT EXISTS (SELECT 1 FROM target) AS found`,
      [chatId, messageId, userId],
    );
    if (!result?.found) {
      throw new HttpError(404, "Message not found in this chat");
    }
  }

  async updateLastSeen(chatId: string, userId: string, messageId: string): Promise<string> {
    const { rows: [result] } = await this.pool.query<{ found: boolean; message_id: string | null }>(
      `WITH target AS (
         SELECT chat_id, id, sent_at FROM messages WHERE chat_id = $1 AND id = $2
       ), advanced AS (
         INSERT INTO chat_last_seen AS current (chat_id, user_id, message_id, message_sent_at)
         SELECT chat_id, $3, id, sent_at FROM target
         ON CONFLICT (chat_id, user_id) DO UPDATE
         SET message_id = EXCLUDED.message_id,
             message_sent_at = EXCLUDED.message_sent_at,
             updated_at = clock_timestamp()
         WHERE (EXCLUDED.message_sent_at, EXCLUDED.message_id) > (current.message_sent_at, current.message_id)
         RETURNING message_id
       )
       SELECT EXISTS (SELECT 1 FROM target) AS found, (SELECT message_id FROM advanced) AS message_id`,
      [chatId, messageId, userId],
    );
    if (!result?.found) {
      throw new HttpError(404, "Message not found in this chat");
    }
    if (result.message_id !== null) {
      return result.message_id;
    }

    // Read the committed position after a stale update, including advances by concurrent requests.
    const { rows: [current] } = await this.pool.query<{ message_id: string }>(
      "SELECT message_id FROM chat_last_seen WHERE chat_id = $1 AND user_id = $2",
      [chatId, userId],
    );
    if (!current) {
      throw new Error("Last-seen position disappeared");
    }
    return current.message_id;
  }
}
