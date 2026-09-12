import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Import pure helpers by re-implementing the same contracts we rely on.
// (cli.mjs is a script with side-effect main; we test lock ownership against real dirs.)

function writeLockMeta(lockPath) {
  const meta = {
    pid: process.pid,
    started_at: Date.now(),
    proc_uptime_s: Math.round(process.uptime()),
    hostname: os.hostname(),
    owner_token: crypto.randomBytes(16).toString('hex'),
  };
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(lockPath, 'pid'), String(meta.pid));
  return meta;
}

function readLockMeta(lockPath) {
  return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
}

function releaseLockOwned(lockPath, ownerToken) {
  const meta = readLockMeta(lockPath);
  if (!meta || !ownerToken || meta.owner_token !== ownerToken) return false;
  fs.rmSync(lockPath, { recursive: true, force: true });
  return true;
}

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

test('releaseLockOwned refuses wrong owner_token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptweb-lock-'));
  const lock = path.join(dir, 'L');
  const meta = writeLockMeta(lock);
  assert.equal(releaseLockOwned(lock, 'not-the-token'), false);
  assert.ok(fs.existsSync(lock));
  assert.equal(releaseLockOwned(lock, meta.owner_token), true);
  assert.ok(!fs.existsSync(lock));
});

test('scanSecrets flags sk- and ignores crypto.randomBytes token code', () => {
  const bad = scanSecrets('here is sk-' + 'a'.repeat(30));
  assert.equal(bad.ok, false);
  assert.equal(bad.matches[0].type, 'openai_key');
  const code = scanSecrets('owner_token: crypto.randomBytes(16).toString("hex")');
  assert.equal(code.ok, true);
});

test('staging lock create is atomic (rename fails if lock exists)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptweb-atomic-'));
  const lock = path.join(dir, 'L');
  const staging = path.join(dir, 'S');
  fs.mkdirSync(staging);
  writeLockMeta(staging);
  fs.renameSync(staging, lock);
  const staging2 = path.join(dir, 'S2');
  fs.mkdirSync(staging2);
  writeLockMeta(staging2);
  assert.throws(() => fs.renameSync(staging2, lock));
  fs.rmSync(staging2, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(lock, 'owner.json')));
});

test('temporary url contract helpers', () => {
  const extract = (url) => {
    const m = /\/c\/([0-9a-f-]{36})/i.exec(url || '');
    return m ? m[1] : null;
  };
  assert.equal(extract('https://chatgpt.com/?temporary-chat=true'), null);
  assert.equal(
    extract('https://chatgpt.com/c/6aa4fe21-1ad0-83e8-99ad-80ee91c4087b'),
    '6aa4fe21-1ad0-83e8-99ad-80ee91c4087b'
  );
});
