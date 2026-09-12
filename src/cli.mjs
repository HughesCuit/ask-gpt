#!/usr/bin/env node
/**
 * ask-gpt — consult a logged-in ChatGPT session from any coding agent.
 *
 * Commands:
 *   login
 *   status [--json]
 *   health [--json]
 *   ask "question" [--json] [--text] [--file path] [--stdin] [--reuse] [--headed] [--wait-lock ms]
 *
 * Isolation default: temporary chat in a new tab.
 * Profile lock default: on (see ~/.ask-gpt/runtime.lock).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chipLooksSelected, thinkingMeta } from './thinking-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
function readPkgVersion() {
  try {
    const raw = fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8').replace(/^﻿/, '');
    const pkg = JSON.parse(raw);
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const PKG_VERSION = readPkgVersion();
const HOME = os.homedir();

const RUNTIME_ROOT = process.env.ASK_GPT_HOME || path.join(HOME, '.ask-gpt');
const DEFAULT_PROFILE = path.join(RUNTIME_ROOT, 'browser-profile');
const LEGACY_PROFILE = path.join(
  HOME,
  '.config',
  'mimocode',
  'skills',
  'ask-gpt',
  '.browser-profile'
);
const LOCK_DIR = path.join(RUNTIME_ROOT, 'runtime.lock');
const DEBUG_ROOT = path.join(RUNTIME_ROOT, 'debug');
const CONV_STORE = path.join(RUNTIME_ROOT, 'conversations.json');
const SELECTORS_PATH =
  process.env.ASK_GPT_SELECTORS || path.join(PKG_ROOT, 'selectors.json');
const USER_SELECTORS = path.join(RUNTIME_ROOT, 'selectors.json');

const BASE_URL = process.env.ASK_GPT_URL || 'https://chatgpt.com/';
const TEMP_URL =
  process.env.ASK_GPT_TEMP_URL || 'https://chatgpt.com/?temporary-chat=true';
const DEFAULT_TIMEOUT = Number(process.env.ASK_GPT_TIMEOUT_MS || 180_000);
const NAV_TIMEOUT = Number(process.env.ASK_GPT_NAV_TIMEOUT_MS || 60_000);
const COMPOSER_TIMEOUT = Number(process.env.ASK_GPT_COMPOSER_TIMEOUT_MS || 25_000);
const REPLY_TIMEOUT = Number(process.env.ASK_GPT_REPLY_TIMEOUT_MS || DEFAULT_TIMEOUT);
const STABLE_TICKS = Number(process.env.ASK_GPT_STABLE_TICKS || 3);
const TICK_MS = Number(process.env.ASK_GPT_TICK_MS || 1000);
const DEFAULT_LOCK_WAIT = Number(process.env.ASK_GPT_LOCK_WAIT_MS || 60_000);

function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveProfile() {
  if (process.env.ASK_GPT_PROFILE) return process.env.ASK_GPT_PROFILE;
  if (fs.existsSync(DEFAULT_PROFILE)) return DEFAULT_PROFILE;
  if (fs.existsSync(LEGACY_PROFILE)) return LEGACY_PROFILE;
  return DEFAULT_PROFILE;
}

const PROFILE_DIR = resolveProfile();

function loadSelectors() {
  const defaults = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf8'));
  try {
    if (fs.existsSync(USER_SELECTORS)) {
      const user = JSON.parse(fs.readFileSync(USER_SELECTORS, 'utf8'));
      const merged = { ...defaults };
      for (const [k, v] of Object.entries(user)) {
        if (k === 'version') {
          merged.version = v;
          continue;
        }
        if (Array.isArray(v) && Array.isArray(defaults[k])) {
          // User entries first (higher priority), keep defaults as fallbacks.
          const seen = new Set();
          merged[k] = [...v, ...defaults[k]].filter((s) => {
            if (typeof s !== 'string' || !s) return false;
            if (seen.has(s)) return false;
            seen.add(s);
            return true;
          });
        } else {
          merged[k] = v;
        }
      }
      return merged;
    }
  } catch (err) {
    process.stderr.write(`warn: bad user selectors.json: ${err.message}\n`);
  }
  return defaults;
}

const SEL = loadSelectors();

function selList(key) {
  const v = SEL[key];
  if (Array.isArray(v)) return v;
  return [];
}

async function ensurePlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    die(
      'playwright-core is not installed. Install this package properly:\n  npm install -g ask-gpt'
    );
  }
}

function detectChannel() {
  if (process.env.ASK_GPT_CHANNEL) return { channel: process.env.ASK_GPT_CHANNEL };
  const candidates = [
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', path.join(HOME, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')],
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/google-chrome-stable'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['msedge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  ];
  for (const [channel, p] of candidates) {
    if (fs.existsSync(p)) return { channel };
  }
  return {};
}

/* -------------------- lock -------------------- */

function readLockMeta(lockPath) {
  try {
    const raw = fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLockMeta(lockPath) {
  const meta = {
    pid: process.pid,
    started_at: Date.now(),
    proc_uptime_s: Math.round(process.uptime()),
    hostname: os.hostname(),
    owner_token: crypto.randomBytes(16).toString('hex'),
    version: PKG_VERSION,
  };
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(lockPath, 'pid'), String(meta.pid));
  return meta;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsStale(lockPath) {
  const meta = readLockMeta(lockPath);
  if (!meta || !meta.pid) {
    try {
      const pid = Number(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8').trim());
      if (!pid) return true;
      return !processAlive(pid);
    } catch {
      return true;
    }
  }
  if (!processAlive(meta.pid)) return true;
  if (meta.hostname && meta.hostname !== os.hostname()) return true;
  // Do NOT force-stale solely on age while the owner process is alive.
  return false;
}

/** Only delete lock if we still own it (owner_token match). */
function releaseLockOwned(lockPath, ownerToken) {
  try {
    const meta = readLockMeta(lockPath);
    if (!meta || !ownerToken || meta.owner_token !== ownerToken) {
      return false;
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function failLockTimeout(code, message) {
  process.stderr.write(message + '\n');
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code,
      error: message,
      retryable: true,
    }) + '\n'
  );
  process.exit(6);
}

/**
 * Atomically create a lock directory that already contains owner.json.
 * Staging dir is fully written, then renamed onto lockPath (fails if exists).
 * Avoids the mkdir → write-meta window where another process sees an ownerless lock.
 */
function tryCreateLockDir(lockPath) {
  const staging =
    lockPath + '.staging.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(staging);
  try {
    const meta = writeLockMeta(staging);
    fs.renameSync(staging, lockPath);
    return meta;
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function acquireLock(waitMs = DEFAULT_LOCK_WAIT) {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const meta = tryCreateLockDir(LOCK_DIR);
      return () => releaseLockOwned(LOCK_DIR, meta.owner_token);
    } catch {
      if (lockIsStale(LOCK_DIR)) {
        try {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() - start >= waitMs) {
        failLockTimeout(
          'LOCK_TIMEOUT',
          'Another instance holds the browser profile lock (~/.ask-gpt/runtime.lock)'
        );
      }
      await sleep(250);
    }
  }
}

/* -------------------- secrets -------------------- */

function scanSecrets(text) {
  const matches = [];
  const named = [
    ['openai_key', /sk-[A-Za-z0-9]{20,}/],
    ['github_token', /ghp_[A-Za-z0-9]{20,}/],
    ['github_pat', /github_pat_[A-Za-z0-9_]{20,}/],
    ['aws_key', /AKIA[0-9A-Z]{16}/],
    ['private_key', /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
    ['slack_token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ];
  for (const [type, re] of named) {
    const m = text.match(re);
    if (m) matches.push({ type, sample: m[0].slice(0, 24) + '…', index: m.index });
  }
  const kv = /(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?([^\s'"]{16,})/i;
  const m = text.match(kv);
  if (m) {
    const val = m[1] || '';
    if (!/^(crypto|process|require|import|fs|path|Buffer|JSON|toString|randomBytes)/i.test(val)) {
      matches.push({ type: 'key_value_secret', sample: (m[0] || '').slice(0, 40) + '…', index: m.index });
    }
  }
  return { ok: matches.length === 0, matches };
}

/* -------------------- browser -------------------- */

const UA =
  process.env.ASK_GPT_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function launch({ headed }) {
  const { chromium } = await ensurePlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const browserOpts = detectChannel();
  return chromium.launchPersistentContext(PROFILE_DIR, {
    ...browserOpts,
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-default-browser-check',
      '--no-first-run',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

function visibleText(text) {
  return (text || '').replace(/\r\n/g, '\n').trim();
}

async function findComposer(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  const selectors = selList('composer');
  while (Date.now() < deadline) {
    let best = null;
    let bestScore = 0;
    for (const sel of selectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const loc = page.locator(sel).nth(i);
        try {
          const score = await loc.evaluate((el) => {
            let s = 0;
            let semantic = false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return 0;
            if (el.classList && el.classList.contains('fallbackTextarea')) return 0;
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 20) return 0;
            s += 20;
            if (el.isContentEditable) s += 30;
            else if (el.tagName === 'TEXTAREA' && !el.disabled && !el.readOnly) s += 25;
            else return 0;
            const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '');
            if (/chat|message|prompt|聊天|输入/i.test(aria)) {
              s += 20;
              semantic = true;
            }
            if (el.id === 'prompt-textarea') {
              s += 20;
              semantic = true;
            }
            if (rect.width > 200 && rect.height > 24) s += 10;
            // Require either semantic match or large primary editor surface.
            if (!semantic && !(el.isContentEditable && rect.width > 400 && rect.height > 40)) return 0;
            return s;
          });
          if (score > bestScore) {
            bestScore = score;
            best = loc;
          }
        } catch {
          /* keep trying */
        }
      }
    }
    if (best && bestScore >= 50) return best;
    await page.waitForTimeout(300);
  }
  return null;
}

async function readComposerText(composer) {
  return (
    (await composer
      .evaluate((el) => {
        if (el.isContentEditable) return el.innerText || el.textContent || '';
        return el.value || '';
      })
      .catch(() => '')) || ''
  );
}

async function fillComposer(page, composer, text) {
  await composer.click({ timeout: 10_000, force: true }).catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
  return visibleText(await readComposerText(composer)).length > 0;
}

async function findSendButton(page) {
  const deadline = Date.now() + 4_000;
  const selectors = selList('send');
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 200 })) return loc;
      } catch {
        /* keep trying */
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function assistantMessages(page) {
  for (const sel of selList('assistant')) {
    const items = page.locator(sel);
    const n = await items.count().catch(() => 0);
    if (n > 0) {
      const texts = [];
      for (let i = 0; i < n; i++) {
        const t = visibleText(await items.nth(i).innerText().catch(() => ''));
        if (t) texts.push(t);
      }
      if (texts.length) return texts;
    }
  }
  return [];
}

async function isStreaming(page) {
  for (const sel of selList('stop')) {
    const vis = await page
      .locator(sel)
      .first()
      .isVisible({ timeout: 150 })
      .catch(() => false);
    if (vis) return true;
  }
  return false;
}

function hashText(t) {
  return crypto.createHash('sha256').update(t || '').digest('hex');
}

async function waitAndCaptureReply(page, timeout, { baselineHash = null, baselineCount = null } = {}) {
  const started = Date.now();
  const startCount = baselineCount ?? (await assistantMessages(page)).length;
  let lastText = '';
  let lastHash = baselineHash;
  let stable = 0;
  let sawNewTurn = false;

  while (Date.now() - started < timeout) {
    const msgs = await assistantMessages(page);
    const current = msgs.length ? msgs[msgs.length - 1] : '';
    const streaming = await isStreaming(page);
    const count = msgs.length;

    // New turn if assistant message count grew, or last text changed vs previous observation.
    if (count > startCount) sawNewTurn = true;

    if (current && current !== lastText) {
      lastText = current;
      stable = 0;
      const h = hashText(current);
      if (!baselineHash || h !== baselineHash) sawNewTurn = true;
      // Text change even with same hash edge is rare; still mark if count grew.
      lastHash = h;
    } else if (current) {
      stable += 1;
    }

    if (sawNewTurn && lastText && !streaming && stable >= STABLE_TICKS) {
      return { text: lastText, hash: lastHash || hashText(lastText), truncated: false };
    }
    await page.waitForTimeout(TICK_MS);
  }

  const stillStreaming = await isStreaming(page);
  if (lastText && sawNewTurn && !stillStreaming && stable >= 2) {
    return { text: lastText, hash: lastHash || hashText(lastText), truncated: false };
  }
  if (lastText && sawNewTurn) {
    return { text: lastText, hash: lastHash || hashText(lastText), truncated: true };
  }
  return null;
}

async function dismissOverlays(page) {
  const dismiss = selList('dismiss');
  for (let pass = 0; pass < 3; pass++) {
    let clicked = false;
    for (const sel of dismiss) {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 150 }).catch(() => false)) {
        await b.click({ timeout: 1500 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(200);
      }
    }
    const dialog = page.locator('dialog[open]').first();
    if (await dialog.isVisible({ timeout: 100 }).catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      clicked = true;
    }
    if (!clicked) break;
  }
}

async function openIsolatedPage(context) {
  const page = await context.newPage();
  await page.goto(TEMP_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(3000);
  await dismissOverlays(page);
  await page.waitForTimeout(500);
  await dismissOverlays(page);
  return page;
}

/**
 * Stronger temporary-session check:
 *  - URL has temporary-chat=true
 *  - URL must NOT be a /c/<uuid> saved conversation
 *  - UI temporary indicator when present
 */
async function assertTemporaryChat(page, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = page.url() || '';
  while (Date.now() < deadline) {
    const url = page.url() || '';
    lastUrl = url;
    const hasTempParam = /temporary-chat=true/i.test(url);
    const hasConvId = !!extractConversationId(url);
    if (hasTempParam && !hasConvId) {
      const badge = page
        .locator(
          '[data-testid*="temporary"], :has-text("Temporary"), :has-text("临时"), [aria-label*="Temporary"], [aria-label*="临时"]'
        )
        .first();
      const hasBadge = await badge.isVisible({ timeout: 250 }).catch(() => false);
      // URL + no conversation id is the hard requirement; badge is a bonus signal.
      return {
        ok: true,
        url,
        has_conversation_id: hasConvId,
        has_badge: hasBadge,
        verified: hasBadge ? 'url+no-cid+badge' : 'url+no-cid',
      };
    }
    await page.waitForTimeout(300);
  }
  return {
    ok: false,
    url: lastUrl,
    has_conversation_id: !!extractConversationId(lastUrl),
    has_temp_param: /temporary-chat=true/i.test(lastUrl),
    verified: false,
  };
}

/** After opening /c/<id>, confirm we did not land on a different/new chat. */
async function verifyConversationOwnership(page, expectedId, { timeoutMs = 10000 } = {}) {
  if (!expectedId) return { ok: true, reason: 'no-expected-id' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = extractConversationId(page.url());
    if (actual && actual.toLowerCase() === expectedId.toLowerCase()) {
      return { ok: true, id: actual };
    }
    // Permanent redirect away from expected chat
    if (actual && actual.toLowerCase() !== expectedId.toLowerCase()) {
      return { ok: false, expected: expectedId, actual };
    }
    await page.waitForTimeout(400);
  }
  const actual = extractConversationId(page.url());
  if (actual && actual.toLowerCase() === expectedId.toLowerCase()) return { ok: true, id: actual };
  return { ok: false, expected: expectedId, actual: actual || null, url: page.url() };
}

/** Saved (normal) chat — history/memory when ChatGPT settings allow. */
async function openSavedPage(context, { conversationId = null } = {}) {
  const page = await context.newPage();
  const url = conversationId ? `https://chatgpt.com/c/${conversationId}` : BASE_URL;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(3000);
  await dismissOverlays(page);
  await page.waitForTimeout(500);
  await dismissOverlays(page);
  return page;
}

/** Read whether a Think/思考 chip looks selected. */
async function readThinkingChipState(page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('button, [role="button"]');
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (!/(思考|thinking|think|reason)/i.test(t) && !/(思考|thinking|think|reason)/i.test(aria)) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const pressed =
        el.getAttribute('aria-pressed') ||
        el.getAttribute('data-state') ||
        el.getAttribute('aria-checked') ||
        el.getAttribute('data-selected') ||
        null;
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      return {
        text: t.slice(0, 30),
        aria,
        pressed,
        selectedAttr:
          el.getAttribute('aria-selected') ||
          (el.closest('[aria-selected="true"]') ? 'ancestor' : null),
        hasActiveClass: /(^|\s)(active|selected|on)(\s|$)/i.test(cls) || /selected|active/i.test(cls),
        html: el.outerHTML.slice(0, 180),
      };
    }
    return null;
  });
}

/**
 * Best-effort enable ChatGPT "Thinking" / reasoning mode.
 * Current UI often exposes a composer chip/button labeled Think / 思考 / Thinking.
 */
async function enableThinkingMode(page) {
  try {
    const before = await readThinkingChipState(page);
    if (chipLooksSelected(before)) {
      return { ok: true, verified: true, method: 'already-on', detail: before };
    }

    const clicked = await page.evaluate(() => {
      const nodes = document.querySelectorAll('button, [role="button"]');
      for (const el of nodes) {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
        const aria = el.getAttribute('aria-label') || '';
        if (!/(思考|thinking|think|reason)/i.test(t) && !/(思考|thinking|think|reason)/i.test(aria)) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        el.click();
        return { text: t.slice(0, 30), aria: aria.slice(0, 40) };
      }
      return null;
    });
    if (clicked) {
      await page.waitForTimeout(500);
      const after = await readThinkingChipState(page);
      const verified = chipLooksSelected(after);
      return {
        ok: true,
        verified,
        method: verified ? 'dom-click-verified' : 'dom-click-unverified',
        detail: after || clicked,
      };
    }

    // model switcher fallback
    let trigger = null;
    for (const sel of selList('thinkingTrigger')) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
        trigger = loc;
        break;
      }
    }
    if (trigger) {
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(450);
    }

    const items = page.locator('[role="menuitem"], [role="option"], [role="menuitemradio"], button');
    const n = await items.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 80); i++) {
      const t = visibleText(await items.nth(i).innerText().catch(() => ''));
      if (/think|思考|reason/i.test(t)) {
        await items.nth(i).click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape').catch(() => {});
        const after = await readThinkingChipState(page);
        const verified = chipLooksSelected(after);
        return {
          ok: true,
          verified,
          method: verified ? 'picker-verified' : 'picker-unverified',
          detail: after || { text: t.slice(0, 30) },
        };
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    const btnTexts = await page
      .evaluate(() =>
        [...document.querySelectorAll('button, [role="button"]')]
          .map((b) => (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 40)
      )
      .catch(() => []);
    return { ok: false, verified: false, method: 'option-not-found', buttons: btnTexts };
  } catch (err) {
    return {
      ok: false,
      verified: false,
      method: 'error:' + String(err.message || err).slice(0, 80),
    };
  }
}

function extractConversationId(url) {
  const m = /\/c\/([0-9a-f-]{36})/i.exec(url || '');
  return m ? m[1] : null;
}

function loadConversations() {
  try {
    if (!fs.existsSync(CONV_STORE)) return {};
    const raw = fs.readFileSync(CONV_STORE, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function saveConversation(name, record) {
  const all = loadConversations();
  all[name] = { ...record, updatedAt: new Date().toISOString() };
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  const tmp = CONV_STORE + '.tmp';
  const payload = JSON.stringify(all, null, 2);
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONV_STORE);
}

function resolveConversationRef(ref) {
  const all = loadConversations();
  if (all[ref]?.id) return { name: ref, id: all[ref].id };
  if (/^[0-9a-f-]{36}$/i.test(ref)) return { name: null, id: ref };
  return null;
}

function conversationLockPath(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(RUNTIME_ROOT, `conv-${safe}.lock`);
}

async function acquireConversationLock(name, waitMs = 30_000) {
  if (!name) return () => {};
  const lockPath = conversationLockPath(name);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
      const meta = tryCreateLockDir(lockPath);
      return () => releaseLockOwned(lockPath, meta.owner_token);
    } catch {
      if (lockIsStale(lockPath)) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() - start >= waitMs) {
        failLockTimeout(
          'CONV_LOCK_TIMEOUT',
          `Conversation "${name}" is locked by another process`
        );
      }
      await sleep(250);
    }
  }
}

async function cmdConversations(format) {
  const all = loadConversations();
  const items = Object.entries(all)
    .map(([name, v]) => ({
      name,
      id: v.id || null,
      title: v.title || null,
      updatedAt: v.updatedAt || null,
      url: v.id ? `https://chatgpt.com/c/${v.id}` : null,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (format === 'json') emit({ ok: true, conversations: items });
  else {
    if (!items.length) process.stdout.write('(no saved conversations)\n');
    for (const it of items) {
      process.stdout.write(`${it.name}\t${it.id || '-'}\t${it.updatedAt || '-'}\n`);
    }
  }
  return 0;
}

async function openReusablePage(context) {
  const pages = context.pages();
  let page = pages.find((p) => (p.url() || '').includes('chatgpt.com'));
  if (!page) page = await context.newPage();
  if (!(page.url() || '').includes('chatgpt.com')) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);
  await dismissOverlays(page);
  return page;
}

async function isLoggedOut(page) {
  for (const sel of selList('loginHints')) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 200 })) {
        const composer = await findComposer(page, 300);
        if (composer) return false;
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/* -------------------- debug artifacts -------------------- */

function scrubHtml(html) {
  if (!html) return html;
  let out = html;
  // emails
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  // JWT-like
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]');
  // common token prefixes
  out = out.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, '[redacted-token]');
  // cookie / auth headers style
  out = out.replace(/(authorization|cookie|set-cookie)\s*[:=]\s*[^\n<]{8,}/gi, '$1: [redacted]');
  return out;
}

async function saveDebugBundle(page, meta) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(DEBUG_ROOT, stamp);
    fs.mkdirSync(DEBUG_ROOT, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const screenshot = path.join(dir, 'screenshot.png');
    const htmlPath = path.join(dir, 'page.html');
    const errPath = path.join(dir, 'error.json');
    const runtimePath = path.join(dir, 'runtime.json');
    if (page) {
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      const html = scrubHtml(await page.content().catch(() => ''));
      fs.writeFileSync(htmlPath, html, { encoding: 'utf8', mode: 0o600 });
    }
    const runtime = {
      version: PKG_VERSION,
      node: process.version,
      platform: process.platform,
      url: page ? page.url() : null,
      title: page ? await page.title().catch(() => null) : null,
      selectors_version: SEL.version,
      profile: PROFILE_DIR,
      timestamp: new Date().toISOString(),
      ...meta,
    };
    fs.writeFileSync(errPath, JSON.stringify(runtime, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), { encoding: 'utf8', mode: 0o600 });
    return dir;
  } catch {
    return null;
  }
}

/* -------------------- results -------------------- */

function failResult(code, error, extra = {}) {
  return { ok: false, code, error, retryable: extra.retryable ?? false, ...extra };
}

function okResult(answer, meta) {
  return {
    ok: true,
    answer,
    meta: {
      timestamp: new Date().toISOString(),
      model: 'chatgpt-web',
      ...meta,
    },
  };
}

function writeOutcome(result, format) {
  if (format === 'json') {
    emit(result);
    return;
  }
  if (result.ok) {
    process.stdout.write(result.answer + '\n');
    return;
  }
  process.stderr.write(`${result.error}: ${result.hint || ''}\n`);
  process.stdout.write(String(result.code || 'ERROR').toUpperCase() + '\n');
}

/* -------------------- args -------------------- */

function parseAskArgs(argv) {
  const flags = new Set();
  const textParts = [];
  let filePath = null;
  let format = null;
  let waitLock = null;
  let name = null;
  let resume = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') filePath = argv[++i];
    else if (a === '--stdin') flags.add('stdin');
    else if (a === '--json') format = 'json';
    else if (a === '--text') format = 'text';
    else if (a === '--new' || a === '--isolate' || a === '--temporary' || a === '--temp') {
      flags.add('temporary');
    } else if (a === '--saved' || a === '--memory' || a === '--persistent') {
      flags.add('saved');
    } else if (a === '--name' || a === '--topic') {
      name = argv[++i];
      flags.add('saved');
    } else if (a === '--resume') {
      resume = argv[++i];
      flags.add('saved');
    } else if (a === '--reuse' || a === '--reuse-session') flags.add('reuse');
    else if (a === '--thinking' || a === '--reason' || a === '--think') flags.add('thinking');
    else if (a === '--headed' || a === '--headless') flags.add(a.slice(2));
    else if (a === '--wait-lock') waitLock = Number(argv[++i]);
    else if (a === '--no-lock') flags.add('no-lock');
    else textParts.push(a);
  }
  return { flags, filePath, format, textParts, waitLock, name, resume };
}

async function resolveQuestion(argv) {
  const parsed = parseAskArgs(argv);
  const { flags, filePath, textParts } = parsed;
  let q = '';
  if (filePath) {
    if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);
    q = fs.readFileSync(filePath, 'utf8');
  } else if (flags.has('stdin')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    q = Buffer.concat(chunks).toString('utf8');
  } else if (textParts.length) {
    q = textParts.join(' ');
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    q = Buffer.concat(chunks).toString('utf8');
  }
  q = q.trim();
  if (!q) die('Empty question. Usage: ask "question" | ask --file path | ask --stdin');
  return { question: q, ...parsed };
}

/* -------------------- commands -------------------- */

async function withProfileLock(fn, waitMs = DEFAULT_LOCK_WAIT) {
  const release = await acquireLock(waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function cmdLogin(format) {
  return withProfileLock(async () => {
  const context = await launch({ headed: true });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissOverlays(page);
    if (format === 'json') {
      emit({ ok: true, status: 'waiting', message: 'Complete login in the browser window.' });
    } else {
      process.stdout.write('Browser opened for ChatGPT login.\n');
      process.stdout.write('Please finish login (and 2FA) in the window.\n');
      process.stdout.write('Waiting up to 10 minutes...\n');
    }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (!(await isLoggedOut(page))) {
        const composer = await findComposer(page, 2_000);
        if (composer) {
          if (format === 'json') emit({ ok: true, status: 'logged_in' });
          else process.stdout.write('LOGIN_OK\n');
          return 0;
        }
      }
      await page.waitForTimeout(1500);
    }
    if (format === 'json') emit(failResult('LOGIN_TIMEOUT', 'Login timed out after 10 minutes', { retryable: true }));
    else process.stderr.write('LOGIN_TIMEOUT\n');
    return 2;
  } finally {
    await context.close().catch(() => {});
  }
  });
}

async function cmdStatus(format) {
  return withProfileLock(async () => {
  const context = await launch({ headed: false });
  try {
    const page = await openReusablePage(context);
    if (await isLoggedOut(page)) {
      if (format === 'json') emit({ ok: false, logged_in: false, status: 'NEED_LOGIN' });
      else process.stdout.write('NEED_LOGIN\n');
      return 2;
    }
    const composer = await findComposer(page, 8_000);
    if (composer) {
      if (format === 'json') emit({ ok: true, logged_in: true, status: 'LOGGED_IN' });
      else process.stdout.write('LOGGED_IN\n');
      return 0;
    }
    const body = visibleText(await page.locator('body').innerText().catch(() => ''));
    if (/cloudflare|checking your browser|just a moment/i.test(body)) {
      if (format === 'json') emit({ ok: false, logged_in: null, status: 'CHALLENGE', retryable: true });
      else {
        process.stdout.write('CHALLENGE\n');
        process.stderr.write('Cloudflare challenge detected. Retry with --headed or login.\n');
      }
      return 3;
    }
    if (format === 'json') emit({ ok: false, logged_in: null, status: 'UNKNOWN' });
    else {
      process.stdout.write('UNKNOWN\n');
      process.stderr.write('Could not find composer. UI may have changed.\n');
    }
    return 1;
  } finally {
    await context.close().catch(() => {});
  }
  });
}

async function cmdHealth(format) {
  return withProfileLock(async () => {
  const started = Date.now();
  const context = await launch({ headed: false });
  try {
    const page = await openIsolatedPage(context);
    const loggedOut = await isLoggedOut(page);
    const composer = await findComposer(page, 8_000);
    const temp = composer ? await assertTemporaryChat(page, { timeoutMs: 3000 }) : { ok: false };
    const latency = Date.now() - started;
    const body = visibleText(await page.locator('body').innerText().catch(() => ''));
    const challenge = /cloudflare|checking your browser|just a moment/i.test(body);
    const result = {
      ok: !!composer && !loggedOut && !challenge && !!temp.ok,
      logged_in: loggedOut ? false : !!composer,
      composer_found: !!composer,
      challenge,
      temporary_chat_ok: !!temp.ok,
      latency_ms: latency,
      profile: PROFILE_DIR,
      selectors_version: SEL.version,
    };
    if (format === 'json') emit(result);
    else {
      process.stdout.write(
        result.ok
          ? `HEALTHY latency_ms=${latency}\n`
          : `UNHEALTHY challenge=${challenge} login=${result.logged_in}\n`
      );
    }
    return result.ok ? 0 : loggedOut ? 2 : challenge ? 3 : 1;
  } finally {
    await context.close().catch(() => {});
  }
  });
}

async function cmdAsk(argv) {
  const started = Date.now();
  const { question, flags, format: fmtArg, waitLock, name, resume } = await resolveQuestion(argv);
  const format = fmtArg || (process.env.ASK_GPT_FORMAT === 'json' ? 'json' : 'text');

  const secretScan = scanSecrets(question);
  if (!secretScan.ok) {
    writeOutcome(
      failResult('SECRET_DETECTED', 'Prompt looks like it contains a secret/key', {
        hint: 'Redact credentials before asking ChatGPT.',
        matched: secretScan.matches,
      }),
      format
    );
    return 5;
  }

  const headed =
    flags.has('headed') || process.env.ASK_GPT_HEADED === '1' || process.env.ASK_GPT_HEADED === 'true';
  const headless = flags.has('headless') ? true : !headed;
  const reuse = flags.has('reuse');
  const wantThinking =
    flags.has('thinking') ||
    process.env.ASK_GPT_THINKING === '1' ||
    process.env.ASK_GPT_THINKING === 'true';
  const wantNoLock = flags.has('no-lock');
  const useLock = !wantNoLock;
  if (wantNoLock) {
    if (process.env.ASK_GPT_ALLOW_NO_LOCK !== '1') {
      writeOutcome(
        failResult(
          'NO_LOCK_DENIED',
          '--no-lock can corrupt the shared browser profile',
          {
            hint: 'Set ASK_GPT_ALLOW_NO_LOCK=1 if you really mean it (not recommended).',
          }
        ),
        format
      );
      return 1;
    }
    process.stderr.write(
      'WARNING: running with --no-lock; concurrent use of the same profile can corrupt cookies/session.\n'
    );
  }
  const requestId = crypto.randomBytes(8).toString('hex');
  const promptFingerprint = crypto.createHash('sha256').update(question).digest('hex').slice(0, 16);

  // Conversation mode:
  //   temporary (default) — isolated, no history
  //   saved --name topic  — normal chat, remember id under name
  //   saved --resume name|id — continue an existing chat
  const wantSaved = flags.has('saved') || !!name || !!resume;
  let conversationId = null;
  let conversationName = name || null;
  if (resume) {
    const resolved = resolveConversationRef(resume);
    if (!resolved) {
      writeOutcome(
        failResult('CONV_NOT_FOUND', `No saved conversation for "${resume}"`, {
          hint: 'Use --name topic on a --saved ask first, or pass a /c/<uuid> id.',
        }),
        format
      );
      return 1;
    }
    conversationId = resolved.id;
    conversationName = conversationName || resolved.name;
  } else if (name) {
    conversationId = loadConversations()[name]?.id || null;
  }

  let release = null;
  let releaseConv = null;
  let context = null;
  let page = null;
  try {
    if (useLock) {
      release = await acquireLock(waitLock ?? DEFAULT_LOCK_WAIT);
    }
    if (wantSaved && conversationName) {
      releaseConv = await acquireConversationLock(conversationName, waitLock ?? DEFAULT_LOCK_WAIT);
    }

    context = await launch({ headed: !headless });
    if (reuse) page = await openReusablePage(context);
    else if (wantSaved) page = await openSavedPage(context, { conversationId });
    else page = await openIsolatedPage(context);

    if (await isLoggedOut(page)) {
      writeOutcome(
        failResult('NEED_LOGIN', 'Not logged in', {
          hint: 'Run: gpt-web-bridge login',
          stage: 'auth',
        }),
        format
      );
      return 2;
    }

    let thinking = { ok: false, method: 'not-requested' };

    // P0: refuse to send if temporary mode cannot be confirmed
    if (!reuse && !wantSaved) {
      const temp = await assertTemporaryChat(page);
      if (!temp.ok) {
        const debugDir = await saveDebugBundle(page, {
          code: 'SESSION_MODE_UNKNOWN',
          stage: 'mode-verify',
          url: temp.url,
        });
        writeOutcome(
          failResult(
            'SESSION_MODE_UNKNOWN',
            'Could not confirm temporary-chat mode; refusing to send (history pollution risk)',
            {
              hint: 'Retry with --headed, or explicitly use --saved --name <topic> if a normal chat is intended.',
              stage: 'mode-verify',
              debug_dir: debugDir,
              retryable: true,
            }
          ),
          format
        );
        return 1;
      }
    }

    // P0: resume ownership — must still be on the expected /c/<id>
    if (wantSaved && conversationId) {
      const own = await verifyConversationOwnership(page, conversationId);
      if (!own.ok) {
        const debugDir = await saveDebugBundle(page, {
          code: 'CONVERSATION_MISMATCH',
          stage: 'resume-verify',
          expected: own.expected,
          actual: own.actual,
          url: own.url,
        });
        writeOutcome(
          failResult(
            'CONVERSATION_MISMATCH',
            `Expected conversation ${conversationId} but landed on ${own.actual || 'unknown'}`,
            {
              hint: 'The chat may have been deleted. Create a new --saved --name chat.',
              stage: 'resume-verify',
              debug_dir: debugDir,
              retryable: false,
            }
          ),
          format
        );
        return 1;
      }
    }

    const composer = await findComposer(page, COMPOSER_TIMEOUT);
    if (!composer) {
      const body = visibleText(await page.locator('body').innerText().catch(() => ''));
      if (/cloudflare|checking your browser|just a moment/i.test(body)) {
        writeOutcome(
          failResult('CHALLENGE', 'Cloudflare challenge', {
            hint: 'Retry with --headed or login.',
            stage: 'navigate',
            retryable: true,
          }),
          format
        );
        return 3;
      }
      const debugDir = await saveDebugBundle(page, { code: 'UI_ERROR', stage: 'composer' });
      writeOutcome(
        failResult('UI_ERROR', 'Composer not found', {
          stage: 'composer',
          debug_dir: debugDir,
          retryable: true,
        }),
        format
      );
      return 1;
    }

    // Enable thinking only after composer is ready (UI fully mounted).
    if (wantThinking) {
      thinking = await enableThinkingMode(page);
      if (!thinking.ok && format === 'text') {
        process.stderr.write(
          `warn: could not enable thinking mode (${thinking.method}); continuing anyway\n`
        );
      }
    }

    let filled = await fillComposer(page, composer, question);
    if (!filled) {
      await composer.evaluate((el, text) => {
        el.focus();
        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.tagName === 'TEXTAREA') {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, question);
      await page.waitForTimeout(200);
      filled = visibleText(await readComposerText(composer)).length > 0;
    }
    if (!filled) {
      const debugDir = await saveDebugBundle(page, { code: 'UI_ERROR', stage: 'fill' });
      writeOutcome(
        failResult('UI_ERROR', 'Failed to fill composer', {
          stage: 'fill',
          debug_dir: debugDir,
          retryable: true,
        }),
        format
      );
      return 1;
    }

    await page.waitForTimeout(200);
    await dismissOverlays(page);

    // Snapshot last assistant message hash so we do not return a stale reply.
    const preMsgs = await assistantMessages(page);
    const baselineHash = preMsgs.length ? hashText(preMsgs[preMsgs.length - 1]) : null;

    let sent = false;
    const send = await findSendButton(page);
    if (send) {
      try {
        await send.click({ timeout: 3000 });
        sent = true;
      } catch {
        await send.click({ timeout: 2000, force: true }).then(() => {
          sent = true;
        }).catch(() => {});
      }
    }
    if (!sent) {
      await page.keyboard.press('Enter').then(() => {
        sent = true;
      }).catch(() => {});
    }

    // Confirm submit: composer cleared, streaming started, or assistant count increased.
    if (sent) {
      const preCount = preMsgs.length;
      const deadline = Date.now() + 6_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const composerNow = visibleText(await readComposerText(composer).catch(() => ''));
        const streamingNow = await isStreaming(page);
        const countNow = (await assistantMessages(page)).length;
        if (!composerNow || streamingNow || countNow > preCount) {
          confirmed = true;
          break;
        }
        await page.waitForTimeout(250);
      }
      if (!confirmed) sent = false;
    }

    if (!sent) {
      const debugDir = await saveDebugBundle(page, { code: 'SEND_ERROR', stage: 'send' });
      writeOutcome(
        failResult('SEND_ERROR', 'Could not confirm message submit (composer/stream/count)', {
          stage: 'send',
          debug_dir: debugDir,
          retryable: true,
        }),
        format
      );
      return 1;
    }

    const reply = await waitAndCaptureReply(page, REPLY_TIMEOUT, {
      baselineHash,
      baselineCount: preMsgs.length,
    });
    const durationMs = Date.now() - started;

    if (!reply || !reply.text) {
      const debugDir = await saveDebugBundle(page, { code: 'TIMEOUT', stage: 'reply' });
      writeOutcome(
        failResult('TIMEOUT', 'No assistant reply captured', {
          duration_ms: durationMs,
          stage: 'reply',
          debug_dir: debugDir,
          retryable: true,
        }),
        format
      );
      return 4;
    }

    const convId = extractConversationId(page.url()) || conversationId;
    const mode = reuse ? 'reused' : wantSaved ? 'saved' : 'temporary';
    if (wantSaved && conversationName && convId) {
      const title = visibleText(
        await page
          .locator('title')
          .innerText()
          .catch(() => '')
      );
      saveConversation(conversationName, { id: convId, title: title || null, mode: 'saved' });
    }

    writeOutcome(
      okResult(reply.text, {
        request_id: requestId,
        prompt_fingerprint: promptFingerprint,
        reply_hash: reply.hash,
        truncated: !!reply.truncated,
        thinking_requested: wantThinking,
        ...thinkingMeta({ ...thinking, requested: wantThinking }),
        duration_ms: durationMs,
        conversation: mode,
        conversation_id: convId,
        conversation_name: conversationName,
        lock: useLock ? 'held' : 'disabled',
      }),
      format
    );
    return 0;
  } catch (err) {
    const debugDir = await saveDebugBundle(page, {
      code: 'EXCEPTION',
      stage: 'unknown',
      message: String(err && err.message ? err.message : err),
    });
    writeOutcome(
      failResult('EXCEPTION', String(err && err.message ? err.message : err), {
        request_id: requestId,
        prompt_fingerprint: promptFingerprint,
        debug_dir: debugDir,
        retryable: true,
      }),
      format
    );
    return 1;
  } finally {
    await context.close().catch(() => {});
    if (releaseConv) releaseConv();
    if (release) release();
  }
}

/* -------------------- main -------------------- */

function wantsJson(rest) {
  return rest.includes('--json') || process.env.ASK_GPT_FORMAT === 'json';
}

async function cmdDoctor(format) {
  const checks = {
    node: { ok: false, detail: process.version },
    playwright_core: { ok: false },
    browser_channel: { ok: false, detail: null },
    profile: { ok: false, detail: PROFILE_DIR },
    selectors: { ok: false, detail: SELECTORS_PATH },
    login: { ok: false, status: null },
  };

  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  checks.node.ok = major >= 18;

  try {
    await import('playwright-core');
    checks.playwright_core.ok = true;
  } catch (err) {
    checks.playwright_core.detail = String(err.message || err);
  }

  const channel = detectChannel();
  checks.browser_channel.ok = !!channel.channel;
  checks.browser_channel.detail = channel.channel || null;

  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const probe = path.join(PROFILE_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    checks.profile.ok = true;
  } catch (err) {
    checks.profile.detail = String(err.message || err);
  }

  try {
    fs.accessSync(SELECTORS_PATH, fs.constants.R_OK);
    checks.selectors.ok = true;
  } catch (err) {
    checks.selectors.detail = String(err.message || err);
  }

  if (checks.playwright_core.ok && checks.browser_channel.ok) {
    await withProfileLock(async () => {
      const context = await launch({ headed: false });
      try {
        const page = await openReusablePage(context);
        checks.login.status = (await isLoggedOut(page)) ? 'NEED_LOGIN' : 'LOGGED_IN';
        checks.login.ok = checks.login.status === 'LOGGED_IN';
      } finally {
        await context.close().catch(() => {});
      }
    });
  } else {
    checks.login.detail = 'skipped (missing playwright-core or browser)';
  }

  const ok = Object.values(checks).every((c) => c.ok);
  const result = { ok, version: PKG_VERSION, checks };
  if (format === 'json') emit(result);
  else {
    for (const [k, v] of Object.entries(checks)) {
      const extra = [v.detail, v.status].filter(Boolean).join(' ');
      process.stdout.write(`${v.ok ? 'OK' : 'FAIL'} ${k}${extra ? ` ${extra}` : ''}\n`);
    }
    process.stdout.write(ok ? 'DOCTOR_OK\n' : 'DOCTOR_FAIL\n');
  }
  return ok ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(PKG_VERSION + '\n');
    return 0;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`gpt-web-bridge — consult a logged-in ChatGPT session

Usage:
  gpt-web-bridge --version
  gpt-web-bridge login
  gpt-web-bridge status|health|doctor [--json]
  gpt-web-bridge conversations [--json]
  gpt-web-bridge ask "question" [--json] [--temporary|--saved] [--name topic] [--resume name|id]
                         [--thinking] [--reuse] [--headed] [--wait-lock ms] [--no-lock]
  gpt-web-bridge ask --file path [--json] [--stdin]

Conversation modes:
  --temporary (default)  isolated temporary chat; no history / memory
  --saved / --name topic normal ChatGPT chat; can use memory; save id under topic
  --resume name|id       continue a previously named (or /c/<uuid>) conversation
  --reuse                reuse an existing chatgpt.com tab (rare)
  --thinking             try enable ChatGPT Thinking/reasoning mode (best-effort)

Defaults:
  temporary chat; profile file lock enabled
  dedicated profile at ~/.ask-gpt/browser-profile

Exit codes:
  0 ok | 1 UI_ERROR/SEND_ERROR | 2 NEED_LOGIN | 3 CHALLENGE | 4 TIMEOUT | 5 SECRET_DETECTED | 6 LOCK_TIMEOUT

Safety (1.0.9+):
  temporary mode requires temporary-chat URL AND no /c/<id> before send
  lock release checks owner_token (no delete-new-owner race)
  --no-lock requires ASK_GPT_ALLOW_NO_LOCK=1
  fill verified before send; send failure is SEND_ERROR (not TIMEOUT)
  reply uses ASK_GPT_REPLY_TIMEOUT_MS; meta.reply_hash avoids stale capture
  SECRET_DETECTED includes matched[]
  debug scrubbed 0700/0600; conversations.json atomic

Runtime:
  ~/.ask-gpt/{browser-profile,runtime.lock,conversations.json,selectors.json,debug/}
`);
    return 0;
  }
  const json = wantsJson(rest);
  if (cmd === 'login') return cmdLogin(json ? 'json' : 'text');
  if (cmd === 'status') return cmdStatus(json ? 'json' : 'text');
  if (cmd === 'health') return cmdHealth(json ? 'json' : 'text');
  if (cmd === 'doctor') return cmdDoctor(json ? 'json' : 'text');
  if (cmd === 'conversations' || cmd === 'convs') return cmdConversations(json ? 'json' : 'text');
  if (cmd === 'ask') return cmdAsk(rest);
  die(`Unknown command: ${cmd}`);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
