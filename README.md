# Chat backend

An HTTP API for 1:1 chats, built with Node.js and strict TypeScript. PostgreSQL stores users, chats, messages, read receipts, and each member’s last-seen message.

## Run locally

Use Node.js 22.9 or later and PostgreSQL 16 or later.

1. Start a PostgreSQL server and create a database. For a disposable database with Docker, run:

   ```sh
   docker run --rm --name chat-postgres -p 127.0.0.1:5432:5432 \
     -e POSTGRES_USER=chat -e POSTGRES_PASSWORD=chat -e POSTGRES_DB=chat postgres:16
   ```

2. In a second terminal, copy `.env.example` to `.env`, then build and start the service:

   ```sh
   cp .env.example .env
   npm ci
   npm run build
   npm run db:migrate
   npm run db:seed
   npm start
   ```

The API listens at `http://127.0.0.1:3000` by default. The seed command creates `alice`, `bob`, and `carol`. Provision additional users by inserting IDs into `users(id)` in PostgreSQL. IDs contain 1 to 128 ASCII letters, digits, underscores, or hyphens.

For an existing PostgreSQL database, run `npm run build` and `npm run db:migrate` to add the messaging tables alongside the existing users and chats.

## API

POST requests use `Content-Type: application/json`.

| Method and path | JSON body or query | Success |
| --- | --- | --- |
| `POST /chat/create` | `{"userAId":"alice","userBId":"bob"}` | `200 {"chatId":"…"}`. Swapping the two IDs returns the same chat. |
| `POST /chat/:chatId/message/send` | `{"senderId":"alice","text":"Hello"}` | `201 {"messageId":"…"}`. The text must be non-blank and at most 4,000 UTF-16 code units. |
| `GET /chat/:chatId/messages` | `limit`, an integer from 1 to 200, defaults to 50 | `200 {"messages":[…]}`. Returns the latest window in oldest-to-newest order. |
| `POST /chat/:chatId/message/:messageId/read` | `{"userId":"bob"}` | `204`. A repeated request preserves the original read timestamp. |
| `POST /chat/:chatId/lastseen` | `{"userId":"bob","messageId":"…"}` | `200 {"messageId":"…"}` with the effective last-seen position. Older updates preserve the current position. |
| `GET /user/:userId/chats` | — | `200 {"chats":[{"chatId":"…","memberIds":["alice","bob"]}]}`. Returns an empty list when there are no chats. |

Each message contains `messageId`, `senderId`, `text`, `timestamp`, and `readReceipts`. A receipt has `userId` and `readAt`. PostgreSQL assigns timestamps, and the API returns them as UTC RFC 3339 strings. Messages with equal timestamps are ordered by message ID. The last-seen endpoint uses the same ordering, and receipt and last-seen updates are independent.

Errors use `{"error":"…"}`. Invalid input returns `400`, a non-member attempting to send or update read state receives `403`, and an unknown chat or a message outside that chat returns `404`. Chat creation also returns `404` if either user is missing.

The API trusts the caller-supplied user IDs. Deploy it behind an authenticated service that verifies caller identity and chat access before forwarding requests.

## Storage and verification

- `users` and `chats` store users and membership. A unique constraint enforces one chat per pair under concurrent requests.
- `messages` stores the sender, text, and timestamp for each chat message.
- `message_read_receipts` stores the first read timestamp per message and member.
- `chat_last_seen` stores the last-seen message per chat and member.

Run `npm run typecheck` for strict TypeScript checking. After building and applying the migrations to a development or test database, run `npm run test:integration`. The suite starts its own API instance and uses isolated PostgreSQL test users.
