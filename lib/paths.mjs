// TeleAgent 本机资源定位（Windows 版目录约定）
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

// 桌面端把数据放在 home 下的 XDG 风格目录（Windows 也如此）
export const DEVICE_DATA_ROOT = path.join(HOME, '.local', 'share', 'TeleAgent');
export const DEVICE_CONFIG_ROOT = path.join(HOME, '.config', 'TeleAgent');
export const DEVICE_CACHE_ROOT = path.join(HOME, '.cache', 'TeleAgent');

export const CURRENT_OWNER_FILE = path.join(DEVICE_DATA_ROOT, 'current-owner.json');
export const LOCAL_STATE_FILE = path.join(DEVICE_DATA_ROOT, 'Local State');
export const DEVICE_META_FILE = path.join(DEVICE_DATA_ROOT, 'app-auth', 'device-meta.json');
export const VERSION_FILE = path.join(DEVICE_DATA_ROOT, 'runtimes', '.version.json');
export const KERNEL_BINARY = path.join(
  DEVICE_DATA_ROOT,
  'runtimes',
  'super-agent-code',
  'bin',
  process.platform === 'win32' ? 'TeleAgent.exe' : 'TeleAgent',
);

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`无法读取 ${file}`);
  }
}

export function resolveOwner() {
  const owner = readJson(CURRENT_OWNER_FILE, null);
  if (!owner?.ownerDir) throw new Error('TeleAgent 尚未登录（缺少 current-owner.json）');
  return owner;
}

export function accountDir(owner = resolveOwner()) {
  return path.join(DEVICE_DATA_ROOT, 'users', owner.ownerDir);
}

export function accountConfigDir(owner = resolveOwner()) {
  return path.join(DEVICE_CONFIG_ROOT, 'users', owner.ownerDir);
}

export function tokenFile(owner = resolveOwner()) {
  return path.join(accountDir(owner), 'app-auth', 'token.json');
}

export function kernelVersion() {
  return readJson(VERSION_FILE, {}).superAgentCode || 'unknown';
}

export function ensureTeleAgentLayout() {
  const missing = [];
  if (!fs.existsSync(KERNEL_BINARY)) missing.push(KERNEL_BINARY);
  if (!fs.existsSync(CURRENT_OWNER_FILE)) missing.push(CURRENT_OWNER_FILE);
  if (!fs.existsSync(LOCAL_STATE_FILE)) missing.push(LOCAL_STATE_FILE);
  return missing;
}
