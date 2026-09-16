import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'config';
  }
}

const PLACEHOLDER = /^\$\{user_config\./;
const OP_REF = /^op:\/\/[^/]+\/[^/]+\/.+$/;
export const OP_TIMEOUT_MS = 25000;

export function present(value) {
  if (value === undefined || value === null) return false;
  const s = String(value).trim();
  return s !== '' && !PLACEHOLDER.test(s);
}

function pick(env, ...names) {
  for (const name of names) if (present(env[name])) return String(env[name]).trim();
  return undefined;
}

export function parseToml(text) {
  const values = {};
  const skipped = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('[')) return;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!m) { skipped.push({ line: index + 1, text: raw }); return; }
    const key = m[1];
    const rest = m[2];
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end === -1) { skipped.push({ line: index + 1, text: raw }); return; }
      values[key] = rest.slice(1, end);
      return;
    }
    const bare = rest.split('#')[0].trim();
    if (bare === '' || /["']/.test(bare)) { skipped.push({ line: index + 1, text: raw }); return; }
    values[key] = bare;
  });
  return { values, skipped };
}

export function configPath({ env = process.env, homedir = os.homedir } = {}) {
  const base = present(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir(), '.config');
  return path.join(base, 'short-io-plugin', 'config.toml');
}

export async function readConfigFile({ env = process.env, homedir, readFile = fsReadFile, stat = fsStat, warn = () => {} } = {}) {
  const file = configPath({ env, homedir });
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: file, values: {}, exists: false };
    throw new ConfigError(`Cannot read ${file}: ${error.message}`);
  }
  try {
    const info = await stat(file);
    if (typeof info.mode === 'number' && (info.mode & 0o077) !== 0) warn(`${file} is readable by other users - run: chmod 600 "${file}"`);
  } catch {
    // the permission check is advisory only
  }
  const { values, skipped } = parseToml(text);
  for (const s of skipped) warn(`${file} line ${s.line} skipped (expected key = value)`);
  return { path: file, values, exists: true };
}

export function findOp({ env = process.env, exists = existsSync } = {}) {
  const dirs = [...String(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'op');
    if (exists(candidate)) return candidate;
  }
  return null;
}

// The op CLI is being asked for the key; it has no business inheriting a copy of one, or a
// pointer to one, from this process. Strip both spellings of all three variables.
export const SECRET_ENV = [
  'SHORT_IO_API_KEY', 'SHORT_IO_KEY_OP_REF', 'SHORT_IO_OP_ACCOUNT',
  'CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_KEY_OP_REF', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_OP_ACCOUNT',
];

export function opChildEnv(env = process.env) {
  const out = { ...env };
  for (const name of SECRET_ENV) delete out[name];
  return out;
}

export function makeExecOp({ execFileImpl = execFile, env = process.env } = {}) {
  return (bin, args, { timeoutMs = OP_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    execFileImpl(bin, args, { timeout: timeoutMs, env: opChildEnv(env), maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed
          ? `op timed out after ${timeoutMs} ms (is 1Password unlocked and the op CLI signed in?)`
          : String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

export async function readOpRef(ref, { account, execOp = makeExecOp(), findOp: find = findOp, timeoutMs = OP_TIMEOUT_MS } = {}) {
  if (!OP_REF.test(String(ref))) throw new ConfigError('1Password reference must look like op://Vault/Item/field');
  const bin = find();
  if (!bin) throw new ConfigError('1Password CLI (op) not found on PATH, /opt/homebrew/bin or /usr/local/bin - brew install 1password-cli');
  const args = ['read'];
  if (present(account)) args.push('--account', String(account).trim());
  args.push('--', ref);
  let value;
  try {
    value = await execOp(bin, args, { timeoutMs });
  } catch (error) {
    throw new ConfigError(`op read failed: ${error.message}`);
  }
  if (!present(value)) throw new ConfigError('op read returned an empty value');
  return String(value).trim();
}

export function assertKeyShape(key) {
  const k = String(key ?? '').trim();
  if (/[\r\n]/.test(k)) throw new ConfigError('API key must be a single line');
  if (k.startsWith('pk_')) throw new ConfigError('This is a PUBLIC key (pk_). Short.io rejects it for the MCP server and for writes. Create a secret key with the Public key toggle OFF at https://app.short.io/settings/integrations/api-key');
  if (!k.startsWith('sk_')) throw new ConfigError('API key should start with sk_ (a Short.io secret key)');
  return k;
}

export async function resolveKey(deps = {}) {
  const { env = process.env } = deps;
  const fromEnv = pick(env, 'SHORT_IO_API_KEY', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY');
  if (fromEnv) return { key: assertKeyShape(fromEnv), source: 'env' };
  const file = await readConfigFile(deps);
  if (present(file.values.api_key)) return { key: assertKeyShape(file.values.api_key), source: 'file' };
  const ref = pick(env, 'SHORT_IO_KEY_OP_REF', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_KEY_OP_REF')
    ?? (present(file.values.op_ref) ? file.values.op_ref.trim() : undefined);
  if (ref) {
    const account = pick(env, 'SHORT_IO_OP_ACCOUNT', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_OP_ACCOUNT')
      ?? (present(file.values.op_account) ? file.values.op_account.trim() : undefined);
    const key = await readOpRef(ref, { account, execOp: deps.execOp, findOp: deps.findOp, timeoutMs: deps.opTimeoutMs });
    return { key: assertKeyShape(key), source: 'op' };
  }
  return { key: null, source: 'none', configPath: file.path };
}

export function dataDir({ env = process.env, homedir = os.homedir } = {}) {
  if (present(env.SHORT_IO_PLUGIN_DATA)) return env.SHORT_IO_PLUGIN_DATA;
  if (present(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA;
  return path.join(homedir(), '.claude', 'plugins', 'data', 'short-io');
}
