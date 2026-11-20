import { readFile } from "node:fs/promises";

import { createPool } from "./postgres.js";

const command = process.argv[2];
if (command !== "migrate" && command !== "seed") {
  throw new Error("Expected migrate or seed");
}

const pool = createPool();
try {
  if (command === "migrate") {
    for (const name of ["001_initial.sql", "002_messages.sql"]) {
      const migration = await readFile(new URL(`../db/${name}`, import.meta.url), "utf8");
      await pool.query(migration);
    }
    console.log("PostgreSQL schema applied");
  } else {
    await pool.query("INSERT INTO users (id) VALUES ($1), ($2), ($3) ON CONFLICT DO NOTHING", [
      "alice", "bob", "carol",
    ]);
    console.log("Demo users available (alice, bob, carol)");
  }
} finally {
  await pool.end();
}
