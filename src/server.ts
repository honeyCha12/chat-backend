import { createApp } from "./app.js";
import { MessageRepository } from "./messages.js";
import { ChatRepository, createPool } from "./postgres.js";

function reportError(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

async function start(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  const host = process.env.HOST ?? "127.0.0.1";

  const pool = createPool();
  try {
    await pool.query("SELECT 1 FROM chat_last_seen LIMIT 0");
  } catch (error) {
    await pool.end();
    throw error;
  }

  const app = createApp(new ChatRepository(pool), new MessageRepository(pool));
  const server = app.listen(port, host, () => console.log(`Chat API listening on ${host}:${port}`));
  let closed = false;
  function closeStores(): void {
    if (closed) return;
    closed = true;
    void pool.end().catch(reportError);
  }

  server.once("error", (error) => {
    reportError(error);
    closeStores();
  });
  process.once("SIGINT", () => server.close(closeStores));
  process.once("SIGTERM", () => server.close(closeStores));
}

void start().catch(reportError);
