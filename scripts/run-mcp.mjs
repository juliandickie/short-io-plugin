#!/usr/bin/env node
// Launcher for the Short.io MCP bridge. Resolves the API key through the shared chain,
// writes it to a 0600 header file in the plugin data dir, and execs mcp-remote against
// https://ai-assistant.short.io/mcp. The key never appears in argv. Short.io has no OAuth,
// so with no key configured there is nothing to start and the launcher exits 2.
// The header file is short lived - it is removed before it is rewritten and again when the
// child exits, so it exists only for the life of one mcp-remote process. It holds a live
// credential in plain text and must never be copied, backed up, committed or otherwise
// moved out of the plugin data dir. The key is also stripped from the child's environment.
// The name carries this process's pid, so two bridges running at once (two sessions, or a
// desktop and a terminal one) never share, overwrite or delete each other's file.
import { writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKey, dataDir, ConfigError, SECRET_ENV } from '../lib/config.mjs';

export const MCP_URL = 'https://ai-assistant.short.io/mcp';
export const HEADER_FILE_PREFIX = 'mcp-remote';

export function headerFileName(pid) { return `${HEADER_FILE_PREFIX}-${pid}.headers`; }

// Variables that can carry the key or a pointer to it. The child reads its credential from
// the header file, so none of these have any business in its environment.
export { SECRET_ENV };

export function proxyPath(dir) { return path.join(dir, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'); }

export function buildArgv({ proxy, headerFile }) {
  const args = [proxy, MCP_URL, '--transport', 'http-only'];
  if (headerFile) args.push('--header-file', headerFile);
  return args;
}

export function childEnv(env) {
  const out = { ...env };
  for (const name of SECRET_ENV) delete out[name];
  return out;
}

export async function main({
  env = process.env, resolve = resolveKey, write = writeFile, mkdirp = mkdir, chmodImpl = chmod, rmImpl = rm, exists = existsSync,
  spawnImpl = spawn, stderr = process.stderr, execPath = process.execPath, pid = process.pid,
  onSignal = (handler) => { for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => handler(sig)); },
} = {}) {
  const dir = dataDir({ env });
  const proxy = proxyPath(dir);
  if (!exists(proxy)) {
    stderr.write(`short-io: mcp-remote is not installed in ${dir}. Open a new session (the SessionStart hook installs it) or run: "${env.CLAUDE_PLUGIN_ROOT ?? '<plugin root>'}/scripts/install-deps.sh"\n`);
    return 2;
  }
  let key = null;
  let configPath;
  try {
    ({ key, configPath } = await resolve({ env, warn: (m) => stderr.write(`short-io: ${m}\n`) }));
  } catch (error) {
    if (error instanceof ConfigError || error?.code === 'config') { stderr.write(`short-io: ${error.message}\n`); return 2; }
    throw error;
  }
  if (key && /[\r\n]/.test(key)) {
    stderr.write('short-io: API key must be a single line\n');
    return 2;
  }
  // Only ever this process's own file, never a sibling bridge's.
  const ownFile = path.join(dir, headerFileName(pid));
  let headerFile = null;
  if (key) {
    headerFile = ownFile;
    await mkdirp(dir, { recursive: true });
    await rmImpl(headerFile, { force: true });
    await write(headerFile, `Authorization: ${key}\n`, { mode: 0o600, flag: 'wx' });
    await chmodImpl(headerFile, 0o600);
  } else {
    // A file left by an earlier run under this pid would still hold a live key, and nothing
    // is about to overwrite it because the bridge is not starting. Clear it now.
    await rmImpl(ownFile, { force: true });
    stderr.write(`short-io: no API key configured (checked env, plugin config, ${configPath ?? 'the config file'}, 1Password). Run /short-io:setup, or put api_key = "sk_..." in the config file. Short.io has no OAuth, so the bridge cannot start without a key.\n`);
    return 2;
  }
  const child = spawnImpl(execPath, buildArgv({ proxy, headerFile }), { stdio: 'inherit', env: childEnv(env) });
  onSignal((sig) => { try { child.kill(sig); } catch { /* already gone */ } });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned || !headerFile) return;
    cleaned = true;
    try { await rmImpl(headerFile, { force: true }); } catch { /* best effort - the key file may already be gone */ }
  };
  return new Promise((done) => {
    child.on('exit', (code) => { cleanup().then(() => done(code ?? 1)); });
    child.on('error', (error) => {
      stderr.write(`short-io: failed to start mcp-remote: ${error.message}\n`);
      cleanup().then(() => done(2));
    });
  });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`short-io: ${error.message}\n`); process.exitCode = 1; });
}
