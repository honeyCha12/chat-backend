import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../dist/app.js";
import { MessageRepository } from "../dist/messages.js";
import { ChatRepository, createPool } from "../dist/postgres.js";

test("chat API", async (t) => {
  const testId = randomUUID();
  const users = [`${testId}_a`, `${testId}_b`, `${testId}_c`];
  const [alice, bob, carol] = users;
  const pool = createPool();
  const app = createApp(new ChatRepository(pool), new MessageRepository(pool));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    try {
      await new Promise((resolve) => server.close(resolve));
      await pool.query(
        "DELETE FROM chats WHERE user_a_id = ANY($1::text[]) AND user_b_id = ANY($1::text[])",
        [users],
      );
      await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [users]);
    } finally {
      await pool.end();
    }
  });
  await once(server, "listening");
  await pool.query("INSERT INTO users (id) SELECT unnest($1::text[])", [users]);

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  async function expectJson(response, status) {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  async function create(userAId, userBId) {
    const result = await expectJson(await post("/chat/create", { userAId, userBId }), 200);
    assert.match(result.chatId, /^[a-f0-9-]{36}$/);
    return result.chatId;
  }

  const [chatId, ...duplicates] = await Promise.all([
    create(alice, bob), create(bob, alice), create(bob, alice), create(alice, bob),
  ]);
  assert.deepEqual(duplicates, [chatId, chatId, chatId]);

  await t.test("validates users and lists the same chat for both members", async () => {
    for (const member of [alice, bob]) {
      const response = await fetch(`${base}/user/${member}/chats`);
      assert.deepEqual(await expectJson(response, 200), { chats: [{ chatId, memberIds: [alice, bob] }] });
    }
    assert.deepEqual(await expectJson(await fetch(`${base}/user/${carol}/chats`), 200), { chats: [] });
    await expectJson(await post("/chat/create", { userAId: alice, userBId: alice }), 400);
    await expectJson(await post("/chat/create", { userAId: alice, userBId: `${testId}_missing` }), 404);
  });

  const chat = `/chat/${chatId}`;
  await t.test("rejects invalid requests and writes by non-members", async () => {
    const messageId = "Z".repeat(20);
    await expectJson(await post(`${chat}/message/send`, { senderId: carol, text: "Hello" }), 403);
    await expectJson(await post(`${chat}/message/send`, { senderId: alice, text: "   " }), 400);
    await expectJson(await post(`${chat}/message/${messageId}/read`, { userId: carol }), 403);
    await expectJson(await post(`${chat}/lastseen`, { userId: carol, messageId }), 403);
    await expectJson(await fetch(`${base}${chat}/messages?limit=0`), 400);
    await expectJson(await fetch(`${base}/chat/${randomUUID()}/messages`), 404);
  });

  await t.test("stores messages and receipts and advances only that member's last-seen position", async () => {
    const list = async (query = "") => {
      return (await expectJson(await fetch(`${base}${chat}/messages${query}`), 200)).messages;
    };
    assert.deepEqual(await list(), []);

    const text = "Hello 🌏\u0000";
    const first = await expectJson(await post(`${chat}/message/send`, { senderId: alice, text }), 201);
    const second = await expectJson(await post(`${chat}/message/send`, { senderId: bob, text: "Hi" }), 201);
    const initial = await list();
    assert.equal(initial.length, 2);
    assert.ok(initial[0].timestamp <= initial[1].timestamp);
    const firstMessage = initial.find(({ messageId }) => messageId === first.messageId);
    const secondMessage = initial.find(({ messageId }) => messageId === second.messageId);
    assert.ok(firstMessage && secondMessage);
    assert.ok(firstMessage.timestamp <= secondMessage.timestamp);
    assert.deepEqual(await list("?limit=1"), [initial.at(-1)]);
    assert.match(firstMessage.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
    assert.equal(firstMessage.text, text);
    assert.equal(firstMessage.senderId, alice);
    assert.deepEqual(firstMessage.readReceipts, []);

    const read = `${chat}/message/${first.messageId}/read`;
    const listReceipts = async () => {
      const message = (await list()).find(({ messageId }) => messageId === first.messageId);
      return message.readReceipts;
    };
    const writes = await Promise.all([post(read, { userId: alice }), post(read, { userId: bob })]);
    assert.deepEqual(writes.map((response) => response.status), [204, 204]);
    const receipts = await listReceipts();
    assert.deepEqual(receipts.map(({ userId }) => userId), [alice, bob]);
    assert.equal((await post(read, { userId: bob })).status, 204);
    assert.deepEqual(await listReceipts(), receipts);

    const ids = [first.messageId, second.messageId].sort();
    const [olderId, newerId] = ids;
    await pool.query("UPDATE messages SET sent_at = $2 WHERE chat_id = $1 AND id = ANY($3::text[])", [
      chatId, "2023-11-14T22:13:20.123456Z", ids,
    ]);
    assert.deepEqual((await list()).map(({ messageId }) => messageId), ids);
    const [latest] = await list("?limit=1");
    assert.equal(latest.messageId, newerId);
    assert.equal(latest.timestamp, "2023-11-14T22:13:20.123456000Z");

    const lastSeen = (userId, messageId) => post(`${chat}/lastseen`, { userId, messageId });
    const positions = await Promise.all([lastSeen(bob, olderId), lastSeen(bob, newerId)]);
    await expectJson(positions[0], 200);
    assert.deepEqual(await expectJson(positions[1], 200), { messageId: newerId });
    assert.deepEqual(await expectJson(await lastSeen(bob, olderId), 200), { messageId: newerId });
    assert.deepEqual(await expectJson(await lastSeen(alice, olderId), 200), { messageId: olderId });
    const { rows: [pointer] } = await pool.query(
      "SELECT message_id, updated_at FROM chat_last_seen WHERE chat_id = $1 AND user_id = $2",
      [chatId, bob],
    );
    assert.equal(pointer.message_id, newerId);
    assert.ok(pointer.updated_at instanceof Date);
    await expectJson(await lastSeen(bob, "Z".repeat(20)), 404);

    const anotherChat = await create(alice, carol);
    await expectJson(await post(`/chat/${anotherChat}/message/${first.messageId}/read`, { userId: alice }), 404);
    await expectJson(await post(`/chat/${anotherChat}/lastseen`, { userId: alice, messageId: first.messageId }), 404);
  });
});
