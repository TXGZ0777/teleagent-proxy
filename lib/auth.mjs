// 登录态解密：Chromium v10 (AES-256-GCM + Local State 里的 DPAPI 主密钥)
//
// v10 布局： ["v10"(3B)] [nonce(12B)] [ciphertext] [tag(16B)]
// 主密钥：Local State -> os_crypt.encrypted_key (base64, 前缀 "DPAPI") -> DPAPI 解保护 -> 32B
//
// Windows 上 DPAPI 只能由系统 API 调；Node 没有内置绑定，所以走 PowerShell 5.1 的
// ProtectedData（把结果写到临时文件，避免在沙箱里用管道捕获子进程输出）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { LOCAL_STATE_FILE, DEVICE_META_FILE, readJson } from './paths.mjs';

const PS_SCRIPT = String.raw`
param([string]$LocalState, [string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$ls = Get-Content -LiteralPath $LocalState -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
if ([Text.Encoding]::ASCII.GetString($raw[0..4]) -ne 'DPAPI') { throw 'unexpected key prefix' }
$blob = $raw[5..($raw.Length - 1)]
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText($OutFile, [Convert]::ToBase64String($key))
`;

let cachedKey = null;

export async function dpapiMasterKey({ force = false } = {}) {
  if (cachedKey && !force) return cachedKey;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-dpapi-'));
  const psFile = path.join(dir, 'unprotect.ps1');
  const outFile = path.join(dir, 'master.b64');
  fs.writeFileSync(psFile, '\uFEFF' + PS_SCRIPT, 'utf8');

  await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, LOCAL_STATE_FILE, outFile],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`DPAPI 解保护失败 (exit ${code})`))));
  });

  const b64 = fs.readFileSync(outFile, 'utf8').trim();
  fs.rmSync(dir, { recursive: true, force: true });
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`主密钥长度异常: ${key.length}`);
  cachedKey = key;
  return key;
}

export function decryptV10(masterKey, blobB64) {
  const raw = Buffer.from(blobB64, 'base64');
  if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('不支持的密文版本（期望 v10）');
  const nonce = raw.subarray(3, 15);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(15, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 读取并解密当前账号的登录态：{ token, tenant, claims } */
export async function loadAuthState({ tokenFile }) {
  const masterKey = await dpapiMasterKey();
  const record = readJson(tokenFile);
  const plain = decryptV10(masterKey, record.encryptedToken);
  // 明文形态： "<tenant>:<jwt>"（不同版本可能只是 jwt）
  const idx = plain.lastIndexOf(':');
  const token = idx >= 0 ? plain.slice(idx + 1) : plain;
  const tenant = idx >= 0 ? plain.slice(0, idx) : '';
  const claims = parseJwt(token);
  return { token, tenant, claims, plain };
}

export function deviceMeta() {
  return readJson(DEVICE_META_FILE, { deviceId: '', installId: '' });
}
