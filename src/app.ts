import express, { type ErrorRequestHandler, type Express } from "express";

import { HttpError } from "./errors.js";
import type { MessageRepository } from "./messages.js";
import type { ChatRepository } from "./postgres.js";

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function userId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError(400, `${field} must be a 1–128 character user ID`);
  }
  return value;
}

function chatId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "chatId must be a UUID");
  }
  return value;
}

function messageId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{20}$/.test(value)) {
    throw new HttpError(400, "messageId must contain 20 ASCII letters or digits");
  }
  return value;
}

function messageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new HttpError(400, "text must be non-blank and at most 4,000 characters");
  }
  return value;
}

function messageLimit(value: unknown): number {
  if (value === undefined) {
    return 50;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200) {
    throw new HttpError(400, "limit must be an integer from 1 to 200");
  }
  return Number(value);
}

const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof URIError || (error instanceof SyntaxError && "type" in error && error.type === "entity.parse.failed")) {
    response.status(400).json({ error: "Malformed request" });
    return;
  }
  if (error instanceof Error && "type" in error) {
    if (error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body is too large" });
      return;
    }
    if (error.type === "charset.unsupported" || error.type === "encoding.unsupported") {
      response.status(415).json({ error: "Unsupported request encoding" });
      return;
    }
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
};

export function createApp(chats: ChatRepository, messages: MessageRepository): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  async function requireMember(rawChatId: string, actorId: string): Promise<string> {
    const chat = await chats.get(chatId(rawChatId));
    if (!chat.memberIds.includes(actorId)) {
      throw new HttpError(403, "User is not a member of this chat");
    }
    return chat.chatId;
  }

  app.post("/chat/create", async (request, response) => {
    const body = bodyObject(request.body);
    const a = userId(body.userAId, "userAId");
    const b = userId(body.userBId, "userBId");
    response.json({ chatId: await chats.createOrGet(a, b) });
  });

  app.post("/chat/:chatId/message/send", async (request, response) => {
    const body = bodyObject(request.body);
    const senderId = userId(body.senderId, "senderId");
    const text = messageText(body.text);
    const id = await requireMember(request.params.chatId, senderId);
    response.status(201).json({ messageId: await messages.send(id, senderId, text) });
  });

  app.get("/chat/:chatId/messages", async (request, response) => {
    const limit = messageLimit(request.query.limit);
    const chat = await chats.get(chatId(request.params.chatId));
    response.json({ messages: await messages.list(chat.chatId, limit) });
  });

  app.post("/chat/:chatId/message/:messageId/read", async (request, response) => {
    const body = bodyObject(request.body);
    const reader = userId(body.userId, "userId");
    const message = messageId(request.params.messageId);
    const id = await requireMember(request.params.chatId, reader);
    await messages.markRead(id, message, reader);
    response.status(204).end();
  });

  app.post("/chat/:chatId/lastseen", async (request, response) => {
    const body = bodyObject(request.body);
    const viewer = userId(body.userId, "userId");
    const message = messageId(body.messageId);
    const id = await requireMember(request.params.chatId, viewer);
    response.json({ messageId: await messages.updateLastSeen(id, viewer, message) });
  });

  app.get("/user/:userId/chats", async (request, response) => {
    const id = userId(request.params.userId, "userId");
    response.json({ chats: await chats.listForUser(id) });
  });

  app.use((_request, _response, next) => next(new HttpError(404, "Route not found")));
  app.use(handleError);
  return app;
}
