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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
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
const SELECTORS_PATH =
  process.env.ASK_GPT_SELECTORS || path.join(PKG_ROOT, 'selectors.json');
const USER_SELECTORS = path.join(RUNTIME_ROOT, 'selectors.json');

const BASE_URL = process.env.ASK_GPT_URL || 'https://chatgpt.com/';
const TEMP_URL =
  process.env.ASK_GPT_TEMP_URL || 'https://chatgpt.com/?temporary-chat=true';
const DEFAULT_TIMEOUT = Number(process.env.ASK_GPT_TIMEOUT_MS || 180_000);
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
      return { ...defaults, ...user, version: user.version ?? defaults.version };
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

function lockIsStale(lockPath) {
  try {
    const pidFile = path.join(lockPath, 'pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

async function acquireLock(waitMs = DEFAULT_LOCK_WAIT) {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
      fs.writeFileSync(path.join(LOCK_DIR, 'started_at'), new Date().toISOString());
      return () => {
        try {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
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
        die(
          JSON.stringify({
            ok: false,
            code: 'LOCK_TIMEOUT',
            error: 'Another ask-gpt instance holds the browser profile lock',
            retryable: true,
            hint: 'Increase --wait-lock or kill the other process',
          })
        );
      }
      await sleep(250);
    }
  }
}

/* -------------------- secrets -------------------- */

function scanSecrets(text) {
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{12,}/i,
  ];
  return patterns.some((re) => re.test(text));
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
    for (const sel of selectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const loc = page.locator(sel).nth(i);
        try {
          const ok = await loc.evaluate((el) => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (el.classList && el.classList.contains('fallbackTextarea')) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 20) return false;
            if (el.isContentEditable) return true;
            if (el.tagName === 'TEXTAREA') {
              return !el.disabled && !el.readOnly && el.offsetParent !== null;
            }
            return false;
          });
          if (ok) return loc;
        } catch {
          /* keep trying */
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function fillComposer(page, composer, text) {
  await composer.click({ timeout: 10_000, force: true }).catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
  const content =
    (await composer
      .evaluate((el) => {
        if (el.isContentEditable) return el.innerText || el.textContent || '';
        return el.value || '';
      })
      .catch(() => '')) || '';
  return content.trim().length > 0;
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

async function waitAndCaptureReply(page, timeout) {
  const started = Date.now();
  const baseline = (await assistantMessages(page)).length;
  let lastText = '';
  let stable = 0;
  let sawContent = false;

  while (Date.now() - started < timeout) {
    const msgs = await assistantMessages(page);
    const current = msgs.length ? msgs[msgs.length - 1] : '';
    const streaming = await isStreaming(page);

    if (current && current !== lastText) {
      lastText = current;
      sawContent = true;
      stable = 0;
    } else if (current) {
      stable += 1;
    }

    const isNewTurn = msgs.length > baseline || sawContent;
    if (isNewTurn && lastText && !streaming && stable >= STABLE_TICKS) {
      return lastText;
    }
    await page.waitForTimeout(TICK_MS);
  }
  return lastText || null;
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
  await page.goto(TEMP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);
  await dismissOverlays(page);
  await page.waitForTimeout(500);
  await dismissOverlays(page);
  return page;
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

async function saveDebugBundle(page, meta) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(DEBUG_ROOT, stamp);
    fs.mkdirSync(dir, { recursive: true });
    const screenshot = path.join(dir, 'screenshot.png');
    const htmlPath = path.join(dir, 'page.html');
    const errPath = path.join(dir, 'error.json');
    if (page) {
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      fs.writeFileSync(htmlPath, html, 'utf8');
    }
    fs.writeFileSync(
      errPath,
      JSON.stringify(
        {
          ...meta,
          url: page ? page.url() : null,
          timestamp: new Date().toISOString(),
          selectors_version: SEL.version,
        },
        null,
        2
      ),
      'utf8'
    );
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') filePath = argv[++i];
    else if (a === '--stdin') flags.add('stdin');
    else if (a === '--json') format = 'json';
    else if (a === '--text') format = 'text';
    else if (a === '--new' || a === '--isolate') flags.add('isolate');
    else if (a === '--reuse' || a === '--reuse-session') flags.add('reuse');
    else if (a === '--headed' || a === '--headless') flags.add(a.slice(2));
    else if (a === '--wait-lock') waitLock = Number(argv[++i]);
    else if (a === '--no-lock') flags.add('no-lock');
    else textParts.push(a);
  }
  return { flags, filePath, format, textParts, waitLock };
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

async function cmdLogin(format) {
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
}

async function cmdStatus(format) {
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
}

async function cmdHealth(format) {
  const started = Date.now();
  const context = await launch({ headed: false });
  try {
    const page = await openIsolatedPage(context);
    const loggedOut = await isLoggedOut(page);
    const composer = await findComposer(page, 8_000);
    const latency = Date.now() - started;
    const body = visibleText(await page.locator('body').innerText().catch(() => ''));
    const challenge = /cloudflare|checking your browser|just a moment/i.test(body);
    const result = {
      ok: !!composer && !loggedOut && !challenge,
      logged_in: loggedOut ? false : !!composer,
      composer_found: !!composer,
      challenge,
      temporary_chat_ok: !!composer,
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
}

async function cmdAsk(argv) {
  const started = Date.now();
  const { question, flags, format: fmtArg, waitLock } = await resolveQuestion(argv);
  const format = fmtArg || (process.env.ASK_GPT_FORMAT === 'json' ? 'json' : 'text');

  if (scanSecrets(question)) {
    writeOutcome(
      failResult('SECRET_DETECTED', 'Prompt looks like it contains a secret/key', {
        hint: 'Redact credentials before asking ChatGPT.',
      }),
      format
    );
    return 5;
  }

  const headed =
    flags.has('headed') || process.env.ASK_GPT_HEADED === '1' || process.env.ASK_GPT_HEADED === 'true';
  const headless = flags.has('headless') ? true : !headed;
  const reuse = flags.has('reuse');
  const useLock = !flags.has('no-lock');
  const requestId = crypto.randomBytes(4).toString('hex');

  let release = null;
  if (useLock) {
    release = await acquireLock(waitLock ?? DEFAULT_LOCK_WAIT);
  }

  const context = await launch({ headed: !headless });
  let page = null;
  try {
    page = reuse ? await openReusablePage(context) : await openIsolatedPage(context);

    if (await isLoggedOut(page)) {
      writeOutcome(
        failResult('NEED_LOGIN', 'Not logged in', {
          hint: 'Run: ask-gpt login',
          stage: 'auth',
        }),
        format
      );
      return 2;
    }

    const composer = await findComposer(page, 25_000);
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

    const filled = await fillComposer(page, composer, question);
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
    }

    await page.waitForTimeout(200);
    await dismissOverlays(page);

    const send = await findSendButton(page);
    if (send) {
      try {
        await send.click({ timeout: 3000 });
      } catch {
        await send.click({ timeout: 2000, force: true }).catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
      }
    } else {
      await page.keyboard.press('Enter');
    }

    const reply = await waitAndCaptureReply(page, DEFAULT_TIMEOUT);
    const durationMs = Date.now() - started;

    if (!reply) {
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

    writeOutcome(
      okResult(reply, {
        request_id: requestId,
        duration_ms: durationMs,
        conversation: reuse ? 'reused' : 'temporary',
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
        debug_dir: debugDir,
        retryable: true,
      }),
      format
    );
    return 1;
  } finally {
    await context.close().catch(() => {});
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
    const context = await launch({ headed: false });
    try {
      const page = await openReusablePage(context);
      checks.login.status = (await isLoggedOut(page)) ? 'NEED_LOGIN' : 'LOGGED_IN';
      checks.login.ok = checks.login.status === 'LOGGED_IN';
    } finally {
      await context.close().catch(() => {});
    }
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
    process.stdout.write(`ask-gpt — consult a logged-in ChatGPT session

Usage:
  ask-gpt --version
  ask-gpt login
  ask-gpt status [--json]
  ask-gpt health [--json]
  ask-gpt doctor [--json]
  ask-gpt ask "question" [--json] [--reuse] [--headed] [--wait-lock ms] [--no-lock]
  ask-gpt ask --file path [--json] [--stdin]

Defaults:
  isolated temporary chat; profile file lock enabled
  dedicated profile at ~/.ask-gpt/browser-profile (never your daily Chrome profile)

Exit codes:
  0 ok | 1 UI_ERROR | 2 NEED_LOGIN | 3 CHALLENGE | 4 TIMEOUT | 5 SECRET_DETECTED | 6 LOCK_TIMEOUT

Runtime:
  home/profile: ~/.ask-gpt
  user selectors override: ~/.ask-gpt/selectors.json
  debug bundles: ~/.ask-gpt/debug/
`);
    return 0;
  }
  const json = wantsJson(rest);
  if (cmd === 'login') return cmdLogin(json ? 'json' : 'text');
  if (cmd === 'status') return cmdStatus(json ? 'json' : 'text');
  if (cmd === 'health') return cmdHealth(json ? 'json' : 'text');
  if (cmd === 'doctor') return cmdDoctor(json ? 'json' : 'text');
  if (cmd === 'ask') return cmdAsk(rest);
  die(`Unknown command: ${cmd}`);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
