#!/usr/bin/env node
/**
 * stonkfun-pair-watcher.mjs (v2 — quote-tokens endpoint)
 *
 * Switched from GET /api/public/v1/pairs to GET /api/quote-tokens, which
 * appears to be the actual complete source of truth the StonkFun frontend
 * uses for available quote tokens (stocks + memecoins), rather than a
 * possibly-filtered/cached view. Confirmed via browser Network tab.
 *
 * Setup:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (comma-separated for multiple
 *   recipients, or a group/channel id) as env vars.
 *
 * Run:
 *   node stonkfun-pair-watcher.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---- Config -----------------------------------------------------------

const API_URL = 'https://www.stonkfun.xyz/api/quote-tokens';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2_500);
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const PORT = process.env.PORT || 8000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'stonkfun-seen-quote-tokens.json');

let lastCheckAt = null;
let lastNewPairCount = 0;
let lastTotalCount = null;

// ---- Helpers ------------------------------------------------------------

function loadSeen() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSeen(seenSet) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seenSet], null, 2));
}

async function fetchQuoteTokens() {
  const res = await fetch(API_URL);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status}: request failed`);
  }
  return body.quoteTokens; // [{ quoteMint, symbol, name, category, launchLabReady, ... }]
}

async function sendTelegramMessage(text) {
  if (TELEGRAM_CHAT_IDS.includes('YOUR_CHAT_ID_HERE') || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.warn('[warn] Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.');
    console.log('[would send]', text);
    return;
  }

  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chatId) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[error] Telegram send failed for chat ${chatId}:`, res.status, body);
    }
  }));
}

function formatMessage(token) {
  const lines = [
    `🆕 *New quote token available on StonkFun*`,
    `*${token.symbol}* — ${token.name}`,
    `Mint: \`${token.quoteMint}\``,
    `Category: ${token.category}`,
    `Launch-ready: ${token.launchLabReady}`,
  ];
  if (token.verification) lines.push(`Verification: ${token.verification}`);
  return lines.join('\n');
}

// ---- Main loop ------------------------------------------------------------

async function tick(seen, isFirstRun) {
  let tokens;
  try {
    tokens = await fetchQuoteTokens();
  } catch (err) {
    console.error('[error] fetching quote-tokens:', err.message);
    return;
  }

  const newTokens = tokens.filter((t) => !seen.has(t.quoteMint));
  lastCheckAt = new Date();
  lastNewPairCount = newTokens.length;

  if (isFirstRun) {
    for (const t of tokens) seen.add(t.quoteMint);
    saveSeen(seen);
    lastTotalCount = tokens.length;
    console.log(`[init] Baseline recorded: ${tokens.length} existing quote tokens. Watching for new ones...`);
    return;
  }

  const countChanged = lastTotalCount !== null && tokens.length !== lastTotalCount;
  if (countChanged) {
    console.log(`[${lastCheckAt.toISOString()}] TOTAL COUNT CHANGED: ${lastTotalCount} -> ${tokens.length}`);
  }
  lastTotalCount = tokens.length;

  if (newTokens.length === 0) {
    console.log(`[${lastCheckAt.toISOString()}] No new quote tokens (${tokens.length} total).`);
    return;
  }

  console.log(`[${lastCheckAt.toISOString()}] ${newTokens.length} new quote token(s) found!`);
  for (const token of newTokens) {
    console.log(' ->', token.symbol, token.quoteMint);
    await sendTelegramMessage(formatMessage(token));
    seen.add(token.quoteMint);
  }
  saveSeen(seen);
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastCheckAt, lastNewPairCount, lastTotalCount }));
  });
  server.listen(PORT, () => console.log(`Health check server listening on :${PORT}`));
}

async function main() {
  console.log('StonkFun quote-token watcher starting...');
  console.log(`Polling ${API_URL} every ${POLL_INTERVAL_MS / 1000}s`);

  if (!RUN_ONCE) startHealthServer();

  let seen = loadSeen();
  const isFirstRun = seen === null;
  if (isFirstRun) seen = new Set();

  await sendTelegramMessage('👋 StonkFun quote-token watcher just started up and is now watching for new quote tokens.');

  await tick(seen, isFirstRun);

  if (RUN_ONCE) {
    console.log('[done] RUN_ONCE set — exiting after single check.');
    return;
  }

  setInterval(() => tick(seen, false), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
