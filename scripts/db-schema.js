#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

loadEnv();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const sql = fs.readFileSync(path.resolve(__dirname, "../db/schema.sql"), "utf8");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log("Schema applied");
  } finally {
    await client.end();
  }
}

function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
