#!/usr/bin/env node

// Preserve production Worker plain-text vars across deploys.
//
// The upstream template (wrangler.jsonc.example) ships placeholder values such as
// FLAREMO_SINGLE_USER_EMAIL = "owner@flaremo.local". A deploy that writes the
// template verbatim would silently overwrite the value a real instance is using.
//
// This step reads the live Worker's plain-text bindings and patches any var whose
// template value is still a placeholder (or empty) with the live value. Vars the
// operator deliberately set in the template are left untouched.
//
// Usage: node ./scripts/preserve-live-vars.mjs [--config wrangler.jsonc]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER_VALUES = new Set([
  "",
  "owner@flaremo.local",
  "FlareMo Owner",
  "https://flaremo.example.workers.dev",
]);

function readArgs(argv) {
  const args = { config: "wrangler.jsonc" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1]) {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function fetchLiveVars(accountId, token, workerName) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/settings`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare settings request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.success) {
    throw new Error(`Cloudflare settings request failed: ${JSON.stringify(payload.errors)}`);
  }
  const vars = new Map();
  for (const binding of payload.result?.bindings ?? []) {
    if (binding.type === "plain_text" && typeof binding.name === "string") {
      vars.set(binding.name, binding.text ?? "");
    }
  }
  return vars;
}

// Minimal JSONC-aware var patcher: rewrites "KEY": "value" entries inside the
// top-level "vars" object without pulling in a full JSONC parser.
function patchVars(text, updates) {
  let result = text;
  for (const [key, value] of updates) {
    const pattern = new RegExp(
      `("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`,
    );
    if (!pattern.test(result)) {
      console.log(`  skip ${key}: not present in config vars`);
      continue;
    }
    result = result.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
    console.log(`  restored ${key}`);
  }
  return result;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    console.log(
      "CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN missing; skipping live var preservation.",
    );
    return;
  }

  const configPath = resolve(args.config);
  const configText = readFileSync(configPath, "utf8");
  const workerName = configText.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  if (!workerName) {
    console.log("Could not determine worker name from config; skipping.");
    return;
  }

  const liveVars = await fetchLiveVars(accountId, token, workerName);
  if (liveVars.size === 0) {
    console.log("Live worker exposes no plain-text vars; nothing to preserve.");
    return;
  }

  const updates = [];
  for (const [key, liveValue] of liveVars) {
    const current = configText.match(
      new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
    )?.[1];
    if (current === undefined) {
      continue;
    }
    if (PLACEHOLDER_VALUES.has(current) && !PLACEHOLDER_VALUES.has(liveValue)) {
      updates.push([key, liveValue]);
    }
  }

  if (updates.length === 0) {
    console.log("All config vars already carry live values; no changes needed.");
    return;
  }

  writeFileSync(configPath, patchVars(configText, updates), "utf8");
  console.log(`Preserved ${updates.length} live var(s) in ${args.config}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
