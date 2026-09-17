#!/usr/bin/env node
/**
 * combined-pair-watcher.mjs
 *
 * Merges the StonkFun and Sunrise watchers into one process. Each source
 * polls on its own schedule (StonkFun fast, Sunrise slow — it's a much
 * lower-frequency listing gateway), but they share ONE seen-mint registry.
 *
 * Priority rule: whichever platform sees a given mint address first is
 * the one that gets to notify. If the same mint later shows up on the
 * other platform too, it's already in the shared registry, so the second
 * platform stays silent for it — no duplicate notifications.
 *
 * Setup: same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars as before.
 *
 * Run:
 *   node combined-pair-watcher.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---- Config -----------------------------------------------------------

const STONKFUN_API_BASE = 'https://www.stonkfun.xyz/api/public/v1';
const SUNRISE_API_BASE = 'https://api.sunrise.xyz';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const STONKFUN_POLL_INTERVAL_MS = Number(process.env.STONKFUN_POLL_INTERVAL_MS || 2_500);
const SUNRISE_POLL_INTERVAL_MS = Number(process.env.SUNRISE_POLL_INTERVAL_MS || 30_000);
const ONLY_LAUNCHABLE = process.env.ONLY_LAUNCHABLE === 'true'; // default false — unfiltered avoids extra upstream delay
const PORT = process.env.PORT || 8000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'combined-seen-mints.json');

let lastCheckAt = { stonkfun: null, sunrise: null };
let totals = { stonkfun: null, sunrise: null };

// ---- Shared seen-registry ------------------------------------------------------------

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

// Synchronous check-and-claim: since both sources' ticks run on the same
// Node event loop and this function does no awaiting, there's no race
// between StonkFun and Sunrise claiming the same mint simultaneously.
function claimIfNew(seen, mint) {
  if (seen.has(mint)) return false;
  seen.add(mint);
  return true;
}

// ---- Telegram ------------------------------------------------------------

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
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[error] Telegram send failed for chat ${chatId}:`, res.status, body);
    }
  }));
}

// ---- StonkFun source ------------------------------------------------------------

async function fetchStonkfunPairs() {
  const url = new URL(`${STONKFUN_API_BASE}/pairs`);
  if (ONLY_LAUNCHABLE) url.searchParams.set('launchable', 'true');

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${body?.error?.code || res.status}: ${body?.error?.message || 'request failed'}`);
  }
  return body.data.pairs; // each has .mint
}

function formatStonkfunMessage(pair) {
  const lines = [
    `🆕 *New pair — first seen on StonkFun*`,
    `*${pair.symbol ?? pair.name ?? 'Unknown'}*${pair.name && pair.symbol ? ` — ${pair.name}` : ''}`,
    `Mint: \`${pair.mint}\``,
  ];
  if (pair.category) lines.push(`Category: ${pair.category}`);
  if (typeof pair.launchable === 'boolean') lines.push(`Launchable: ${pair.launchable}`);
  return lines.join('\n');
}

async function tickStonkfun(seen, isFirstRun) {
  let pairs;
  try {
    pairs = await fetchStonkfunPairs();
  } catch (err) {
    console.error('[error][stonkfun] fetching pairs:', err.message);
    return;
  }

  lastCheckAt.stonkfun = new Date();
  totals.stonkfun = pairs.length;

  if (isFirstRun) {
    for (const p of pairs) seen.add(p.mint);
    saveSeen(seen);
    console.log(`[init][stonkfun] Baseline recorded: ${pairs.length} existing pairs.`);
    return;
  }

  let newCount = 0;
  for (const pair of pairs) {
    if (!claimIfNew(seen, pair.mint)) continue; // already claimed by this or the other source
    newCount++;
    console.log(`[${lastCheckAt.stonkfun.toISOString()}][stonkfun] NEW:`, pair.symbol || pair.name, pair.mint);
    await sendTelegramMessage(formatStonkfunMessage(pair));
  }
  if (newCount > 0) saveSeen(seen);

  console.log(`[${lastCheckAt.stonkfun.toISOString()}][stonkfun] Checked: ${pairs.length} total, ${newCount} new.`);
}

// ---- Sunrise source ------------------------------------------------------------

async function fetchSunriseTokens() {
  const tokens = [];
  let cursor = null;

  do {
    const url = new URL(`${SUNRISE_API_BASE}/v1/tokens`);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error(`${body?.error?.code || res.status}: ${body?.error?.message || 'request failed'}`);
    }

    tokens.push(...body.data.tokens); // each has .address
    cursor = body.data.pagination.nextCursor;
  } while (cursor);

  return tokens;
}

function formatSunriseMessage(token) {
  const lines = [
    `🆕 *New pair — first seen on Sunrise*`,
    `*${token.symbol}* — ${token.name}`,
    `Mint: \`${token.address}\``,
    `Platform: ${token.platform || 'unknown'}`,
  ];
  if (token.stock) {
    lines.push(`Linked stock: *${token.stock.ticker}*${token.stock.exchange ? ` (${token.stock.exchange.name})` : ''}`);
  }
  return lines.join('\n');
}

async function tickSunrise(seen, isFirstRun) {
  let tokens;
  try {
    tokens = await fetchSunriseTokens();
  } catch (err) {
    console.error('[error][sunrise] fetching tokens:', err.message);
    return;
  }

  lastCheckAt.sunrise = new Date();
  totals.sunrise = tokens.length;

  if (isFirstRun) {
    for (const t of tokens) seen.add(t.address);
    saveSeen(seen);
    console.log(`[init][sunrise] Baseline recorded: ${tokens.length} existing tokens.`);
    return;
  }

  let newCount = 0;
  for (const token of tokens) {
    if (!claimIfNew(seen, token.address)) continue;
    newCount++;
    console.log(`[${lastCheckAt.sunrise.toISOString()}][sunrise] NEW:`, token.symbol, token.address);
    await sendTelegramMessage(formatSunriseMessage(token));
  }
  if (newCount > 0) saveSeen(seen);

  console.log(`[${lastCheckAt.sunrise.toISOString()}][sunrise] Checked: ${tokens.length} total, ${newCount} new.`);
}

// ---- Health server + main ------------------------------------------------------------

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastCheckAt, totals }));
  });
  server.listen(PORT, () => console.log(`Health check server listening on :${PORT}`));
}

async function main() {
  console.log('Combined StonkFun + Sunrise pair watcher starting...');
  console.log(`StonkFun poll: every ${STONKFUN_POLL_INTERVAL_MS / 1000}s | Sunrise poll: every ${SUNRISE_POLL_INTERVAL_MS / 1000}s`);

  startHealthServer();

  let seen = loadSeen();
  const isFirstRun = seen === null;
  if (isFirstRun) seen = new Set();

  await sendTelegramMessage('👋 Combined pair watcher started — watching StonkFun and Sunrise. Whichever sees a pair first gets the notification.');

  // Bootstrap both sources' baselines before starting the loops, so we
  // don't miss the "who's first" race on the very first real tick.
  await tickStonkfun(seen, isFirstRun);
  await tickSunrise(seen, isFirstRun);

  setInterval(() => tickStonkfun(seen, false), STONKFUN_POLL_INTERVAL_MS);
  setInterval(() => tickSunrise(seen, false), SUNRISE_POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
