import { readFile as fsReadFile, stat as fsStat, realpath as fsRealpath } from 'node:fs/promises';
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

const ACCOUNT_HEADER = /^\[accounts\.([A-Za-z0-9_-]+)\]\s*(#.*)?$/;
const SECTION_KEYS = new Set(['api_key', 'op_ref', 'op_account', 'folders']);
const FOLDER_ARRAY = /^\[((?:\s*"[^"]*"\s*,)*(?:\s*"[^"]*")?)\s*,?\s*\]\s*(#.*)?$/;

function parseScalar(rest) {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end === -1 ? undefined : rest.slice(1, end);
  }
  const bare = rest.split('#')[0].trim();
  return bare === '' || /["']/.test(bare) ? undefined : bare;
}

function parseFolderArray(rest) {
  const m = rest.match(FOLDER_ARRAY);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((f) => f[1]) : undefined;
}

// Keys belong to the section above them. A key under a section this parser does not read goes
// nowhere, because merging those into the top level let the last api_key in a file silently win.
export function parseToml(text) {
  const values = {};
  const skipped = [];
  const sections = [];
  const ignored = [];
  const unknown = [];
  let section = null;
  let readable = true;
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line.startsWith('[')) {
      const header = line.match(ACCOUNT_HEADER);
      readable = Boolean(header);
      section = header ? { name: header[1], line: index + 1, values: {}, repeats: [], badFolders: null } : null;
      if (header) sections.push(section); else ignored.push({ line: index + 1, accountLike: /account/i.test(line) });
      return;
    }
    if (!readable) return;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!m) { skipped.push({ line: index + 1, text: raw, section: section?.name }); return; }
    const [, key, rest] = m;
    if (section && !SECTION_KEYS.has(key)) { unknown.push(index + 1); return; }
    const value = section && key === 'folders' && rest.startsWith('[') ? parseFolderArray(rest) : parseScalar(rest);
    if (value === undefined) {
      skipped.push({ line: index + 1, text: raw, key, section: section?.name });
      if (section && key === 'folders') section.badFolders = index + 1;
      return;
    }
    if (section && Object.hasOwn(section.values, key)) section.repeats.push(key);
    (section ? section.values : values)[key] = value;
  });
  return { values, skipped, sections, ignored, unknown };
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
    if (error && error.code === 'ENOENT') return { path: file, values: {}, sections: [], ignored: [], exists: false };
    throw new ConfigError(`Cannot read ${file}: ${error.message}`);
  }
  try {
    const info = await stat(file);
    if (typeof info.mode === 'number' && (info.mode & 0o077) !== 0) warn(`${file} is readable by other users - run: chmod 600 "${file}"`);
  } catch {
    // the permission check is advisory only
  }
  const { values, skipped, sections, ignored, unknown } = parseToml(text);
  for (const s of skipped) warn(`${file} line ${s.line} skipped (expected key = value)`);
  for (const { line } of ignored) warn(`${file} line ${line} section skipped, and its keys are ignored (only [accounts.<name>] is read)`);
  for (const line of unknown) warn(`${file} line ${line} ignored (a section takes only api_key, op_ref, op_account and folders, and top-level keys go above the first section)`);
  return { path: file, values, sections, ignored, exists: true };
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

async function resolveSection(values, deps) {
  if (present(values.api_key)) return { key: assertKeyShape(values.api_key), source: 'file' };
  const account = present(values.op_account) ? values.op_account.trim() : undefined;
  const key = await readOpRef(values.op_ref.trim(), { account, execOp: deps.execOp, findOp: deps.findOp, timeoutMs: deps.opTimeoutMs });
  return { key: assertKeyShape(key), source: 'op' };
}

// deps.account is a named account from loadAccounts, which reads its own section only. Without
// one this is the single-key chain. deps.file saves reading, and warning about, the file twice.
export async function resolveKey(deps = {}) {
  const { env = process.env } = deps;
  if (deps.account?.values) return resolveSection(deps.account.values, deps);
  const fromEnv = pick(env, 'SHORT_IO_API_KEY', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY');
  if (fromEnv) return { key: assertKeyShape(fromEnv), source: 'env' };
  const file = deps.file ?? await readConfigFile(deps);
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

export function matchFolder(folder, accounts) {
  let best = null;
  for (const account of accounts) {
    for (const f of account.folders) {
      const inside = folder === f || folder.startsWith(f.endsWith(path.sep) ? f : `${f}${path.sep}`);
      if (inside && (!best || f.length > best.folder.length)) best = { account, folder: f };
    }
  }
  return best;
}

export function routingOrder(model) {
  const first = [model.folderAccount, model.default].map((name) => model.accounts.find((a) => a.name === name)).filter(Boolean);
  return [...new Set([...first, ...model.accounts])];
}

function expandHome(folder, home) {
  if (folder === '~') return home;
  return folder.startsWith('~/') ? path.join(home, folder.slice(2)) : folder;
}

async function realOr(realpath, p, onFail = () => {}) {
  try { return await realpath(p); } catch { onFail(); return path.resolve(p); }
}

// A key pasted into the wrong place must not come back out in an error.
const shown = (value) => (/^[sp]k_/.test(String(value).trim()) ? '<a key>' : value);

async function readFolders(section, file, { home, realpath, warn, owners }) {
  if (section.badFolders) throw new ConfigError(`${file.path} line ${section.badFolders}: folders must be a string or a one-line array of double-quoted strings. Put the whole array on one line.`);
  const folders = [];
  for (const entry of [section.values.folders ?? []].flat()) {
    const expanded = expandHome(entry.trim(), home);
    if (!path.isAbsolute(expanded)) throw new ConfigError(`${file.path}: folder "${shown(entry)}" in [accounts.${section.name}] must be a full path or start with ~/. Change it.`);
    const real = await realOr(realpath, path.resolve(expanded), () => warn(`${file.path}: folder ${expanded} in [accounts.${section.name}] does not exist or cannot be read. Check it for a typo, because a session there would use another account.`));
    if (owners.has(real) && owners.get(real) !== section.name) throw new ConfigError(`${file.path}: folder ${real} is listed by both [accounts.${owners.get(real)}] and [accounts.${section.name}]. Keep it under one account.`);
    owners.set(real, section.name);
    if (!folders.includes(real)) folders.push(real);
  }
  return folders;
}

// An environment key needed no file in 0.1.0, so a one-key user must not start hearing about it,
// and a broken file must not stop them. It is still read, because named accounts beside that key
// are an error.
async function readBesideEnvKey(deps, warn) {
  try { return await readConfigFile({ ...deps, warn: () => {} }); } catch (error) {
    warn(`${error.message}. Using the key from the environment.`);
    return { path: configPath(deps), values: {}, sections: [], ignored: [], exists: false };
  }
}

// The single-key file and the no-file case are one account named default, with no values, so
// resolveKey runs the 0.1.0 chain for them. Every error here names what to change, and none
// repeats a value from the file or the environment.
export async function loadAccounts(deps = {}) {
  const { env = process.env, homedir = os.homedir, warn = () => {}, cwd = process.cwd, realpath = fsRealpath } = deps;
  const envKey = pick(env, 'SHORT_IO_API_KEY', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY');
  const file = envKey ? await readBesideEnvKey(deps, warn) : await readConfigFile(deps);
  // A mistyped header would drop its account, key and folders, and a session in those folders
  // would then write to another account. A one-key file may hold other sections, as it could
  // in 0.1.0, unless the header looks like an account. The header itself is never repeated.
  const badHeader = file.sections.length ? file.ignored[0] : file.ignored.find((i) => i.accountLike);
  if (badHeader) throw new ConfigError(`${file.path} line ${badHeader.line}: this section header is not [accounts.<name>], so its account would vanish and a session in its folders would use another account. Fix the header, or remove the section.`);
  if (file.sections.length === 0) {
    let folder = null;
    try { folder = cwd(); } catch { /* a deleted working folder means nothing to one key */ }
    return { named: false, file, accounts: [{ name: 'default', folders: [] }], default: 'default', folder, folderAccount: 'default', rule: 'single key' };
  }
  const setting = SECRET_ENV.find((name) => present(env[name]));
  if (setting) throw new ConfigError(`${setting} is set (the plugin settings field sets it too) while ${file.path} has [accounts.*] sections, so two keys could compete. Move the key into an [accounts.<name>] section, then empty the setting. Saving the plugin settings field blank does not clear it, so reinstall the plugin - claude plugin uninstall short-io@<marketplace> --keep-data, then claude plugin install short-io@<marketplace>. If the variable is set in your shell, unset it there.`);
  if (present(file.values.api_key) || present(file.values.op_ref)) throw new ConfigError(`${file.path}: a top-level api_key or op_ref sits beside [accounts.*] sections, so two keys could compete. Move it into an [accounts.<name>] section.`);
  if (present(file.values.op_account)) warn(`${file.path}: the top-level op_account reaches no account. Move it into the [accounts.<name>] section that uses it.`);
  const names = file.sections.map((section) => section.name);
  const accounts = [];
  const owners = new Map();
  const home = homedir();
  for (const section of file.sections) {
    if (accounts.some((a) => a.name === section.name)) throw new ConfigError(`${file.path} line ${section.line}: [accounts.${section.name}] appears twice, so two keys could compete. Keep one.`);
    if (section.repeats.length) throw new ConfigError(`${file.path}: [accounts.${section.name}] sets ${section.repeats[0]} twice, so the last one would silently win. Keep one.`);
    if (!present(section.values.api_key) && !present(section.values.op_ref)) throw new ConfigError(`${file.path}: [accounts.${section.name}] has neither api_key nor op_ref. Add one of them, or remove the section.`);
    accounts.push({ name: section.name, folders: await readFolders(section, file, { home, realpath, warn, owners }), values: section.values });
  }
  const named = present(file.values.default) ? file.values.default.trim() : undefined;
  if (named && !names.includes(named)) throw new ConfigError(`${file.path}: default = "${shown(named)}" names no account. Accounts: ${names.join(', ')}. Change default to one of them, or add that account.`);
  const fallback = named ?? (accounts.length === 1 ? accounts[0].name : undefined);
  let here;
  try { here = cwd(); } catch { throw new ConfigError('The working folder no longer exists, so no account can be chosen for it. Run this from a folder that exists.'); }
  const folder = await realOr(realpath, here);
  const hit = matchFolder(folder, accounts);
  const rule = hit ? `folder ${hit.folder} matches ${folder}` : fallback ? 'no folder matched, using the default' : 'no folder matched and there is no default';
  return { named: true, file, accounts, default: fallback, folder, folderAccount: hit?.account.name ?? fallback ?? null, rule };
}

export async function resolveBridgeKey(deps = {}) {
  const model = await loadAccounts(deps);
  if (!model.named) return resolveKey({ ...deps, file: model.file });
  const account = model.accounts.find((a) => a.name === model.folderAccount);
  if (!account) throw new ConfigError(`No account for ${model.folder}: no folder matched and ${model.file.path} has no default. Add default = "<name>" above the first section, or add this folder to an account's folders. Accounts: ${model.accounts.map((a) => a.name).join(', ')}.`);
  const { key, source } = await resolveKey({ ...deps, account });
  return { key, source, account: account.name, rule: model.rule };
}

export function dataDir({ env = process.env, homedir = os.homedir } = {}) {
  if (present(env.SHORT_IO_PLUGIN_DATA)) return env.SHORT_IO_PLUGIN_DATA;
  if (present(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA;
  return path.join(homedir(), '.claude', 'plugins', 'data', 'short-io');
}
