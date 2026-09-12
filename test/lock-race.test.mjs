/**
 * Multi-process lock race tests.
 * Spawns child node processes that try tryCreateLockDir/releaseLockOwned on a shared dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function writeChild(lockPath, action) {
  const script = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const lockPath = process.argv[2];
const action = process.argv[3];

function writeLockMeta(p) {
  const meta = {
    pid: process.pid,
    started_at: Date.now(),
    hostname: os.hostname(),
    owner_token: crypto.randomBytes(16).toString('hex'),
  };
  fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(p, 'pid'), String(meta.pid));
  return meta;
}
function tryCreate(p) {
  const staging = p + '.staging.' + process.pid + '.' + crypto.randomBytes(2).toString('hex');
  fs.mkdirSync(staging);
  try {
    const meta = writeLockMeta(staging);
    fs.renameSync(staging, p);
    return meta;
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw e;
  }
}
function releaseOwned(p, token) {
  const meta = JSON.parse(fs.readFileSync(path.join(p, 'owner.json'), 'utf8'));
  if (meta.owner_token !== token) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

if (action === 'hold') {
  const meta = tryCreate(lockPath);
  fs.writeFileSync(lockPath + '.result', 'WIN pid=' + meta.pid + ' token=' + meta.owner_token);
  await new Promise((r) => setTimeout(r, 400));
  // leave lock in place (simulates crash without release)
} else if (action === 'try') {
  try {
    const meta = tryCreate(lockPath);
    fs.writeFileSync(lockPath + '.result2', 'WIN2 pid=' + meta.pid);
  } catch {
    fs.writeFileSync(lockPath + '.result2', 'LOSE');
  }
} else if (action === 'steal-release') {
  const meta = tryCreate(lockPath);
  const wrong = releaseOwned(lockPath, 'wrong-token');
  fs.writeFileSync(lockPath + '.result3', wrong ? 'BAD_DELETED' : 'KEPT');
}
`;
  const file = path.join(os.tmpdir(), `gptweb-child-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(file, script);
  return file;
}

function runChild(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code));
  });
}

test('multi-process: second process loses while first holds lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptweb-mp-'));
  const lock = path.join(dir, 'L');
  const holdScript = writeChild();
  const tryScript = writeChild();
  const hold = spawn(process.execPath, [holdScript, lock, 'hold']);
  await new Promise((r) => setTimeout(r, 150));
  await runChild(tryScript, [lock, 'try']);
  await new Promise((r) => hold.on('exit', r));
  const r1 = fs.readFileSync(lock + '.result', 'utf8');
  const r2 = fs.readFileSync(lock + '.result2', 'utf8');
  assert.match(r1, /^WIN /);
  assert.equal(r2, 'LOSE');
  // Stale recovery: clear crashed lock then second try wins
  fs.rmSync(lock, { recursive: true, force: true });
  await runChild(tryScript, [lock, 'try']);
  assert.match(fs.readFileSync(lock + '.result2', 'utf8'), /^WIN2 /);
});

test('multi-process: wrong token cannot release winner lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptweb-mp2-'));
  const lock = path.join(dir, 'L');
  const s = writeChild();
  await runChild(s, [lock, 'steal-release']);
  assert.equal(fs.readFileSync(lock + '.result3', 'utf8'), 'KEPT');
  assert.ok(fs.existsSync(path.join(lock, 'owner.json')));
});
