#!/usr/bin/env node

const { dataHealthPayload } = require("../work/strategy-dashboard/server");

async function main() {
  const args = process.argv.slice(2);
  const dateFlagIndex = args.indexOf("--date");
  const dateArg = args.find((arg) => arg.startsWith("--date="));
  const date = dateArg?.slice("--date=".length) || (dateFlagIndex >= 0 ? args[dateFlagIndex + 1] : args[0]) || "";
  const result = await dataHealthPayload({ date });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "error") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
