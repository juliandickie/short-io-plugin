import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveBridgeKey } from '../lib/config.mjs';
import { main, proxyPath, buildArgv, childEnv, MCP_URL, HEADER_FILE_PREFIX, headerFileName, SECRET_ENV } from '../scripts/run-mcp.mjs';

const PID = 4242;
const HEADERS = `/data/${headerFileName(PID)}`;

function fakeSpawn(exitCode = 0) {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.kill = () => {};
    spawned.push({ cmd, args, opts, child });
    setImmediate(() => child.emit('exit', exitCode));
    return child;
  };
  return { spawnImpl, spawned };
}

function failingSpawn(message = 'spawn ENOENT') {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.kill = () => {};
    spawned.push({ cmd, args, opts, child });
    setImmediate(() => child.emit('error', new Error(message)));
    return child;
  };
  return { spawnImpl, spawned };
}

const base = (over = {}) => {
  const writes = []; const chmods = []; const errs = []; const rms = []; const ops = [];
  const { spawnImpl, spawned } = fakeSpawn();
  return {
    deps: {
      env: {
        SHORT_IO_PLUGIN_DATA: '/data', CLAUDE_PLUGIN_ROOT: '/root', PATH: '/usr/bin',
        SHORT_IO_API_KEY: 'SECRET', SHORT_IO_KEY_OP_REF: 'op://Vault/Item/field', SHORT_IO_OP_ACCOUNT: 'team.1password.com',
        CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY: 'SECRET',
      },
      resolve: async () => ({ key: 'SECRET', source: 'file' }),
      write: async (p, text, opts) => { writes.push({ p, text, opts }); ops.push('write'); },
      mkdirp: async () => {}, chmodImpl: async (p, mode) => { chmods.push({ p, mode }); },
      rmImpl: async (p, opts) => { rms.push({ p, opts }); ops.push('rm'); },
      exists: () => true, spawnImpl, stderr: { write: (s) => errs.push(s) }, execPath: '/usr/bin/node', onSignal: () => {}, pid: PID,
      ...over,
    },
    writes, chmods, errs, spawned, rms, ops,
  };
};

test('proxyPath and buildArgv', () => {
  assert.equal(proxyPath('/data'), '/data/node_modules/mcp-remote/dist/proxy.js');
  assert.equal(MCP_URL, 'https://ai-assistant.short.io/mcp');
  assert.equal(HEADER_FILE_PREFIX, 'mcp-remote');
  assert.equal(headerFileName(4242), 'mcp-remote-4242.headers');
  assert.notEqual(headerFileName(4242), headerFileName(9999));
  assert.deepEqual(buildArgv({ proxy: '/p.js', headerFile: '/data/h' }), ['/p.js', 'https://ai-assistant.short.io/mcp', '--transport', 'http-only', '--header-file', '/data/h']);
  assert.deepEqual(buildArgv({ proxy: '/p.js', headerFile: null }), ['/p.js', 'https://ai-assistant.short.io/mcp', '--transport', 'http-only']);
});

test('childEnv strips every key-bearing variable and keeps the rest', () => {
  const env = { PATH: '/usr/bin', CLAUDE_PLUGIN_ROOT: '/root', SHORT_IO_API_KEY: 'SECRET', SHORT_IO_KEY_OP_REF: 'op://a/b/c', SHORT_IO_OP_ACCOUNT: 'team.1password.com' };
  const out = childEnv(env);
  for (const name of SECRET_ENV) assert.equal(name in out, false, `${name} should be stripped`);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.CLAUDE_PLUGIN_ROOT, '/root');
  assert.equal(env.SHORT_IO_API_KEY, 'SECRET', 'the caller env must not be mutated');
});

test('with a key the launcher writes a 0600 header file and never puts the key in argv', async () => {
  const h = base();
  assert.equal(await main(h.deps), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].p, HEADERS);
  assert.equal(h.writes[0].text, 'Authorization: SECRET\n');
  assert.equal(h.writes[0].opts.mode, 0o600);
  assert.equal(h.writes[0].opts.flag, 'wx');
  assert.deepEqual(h.chmods, [{ p: HEADERS, mode: 0o600 }]);
  const { cmd, args, opts } = h.spawned[0];
  assert.equal(cmd, '/usr/bin/node');
  assert.equal(args.join(' ').includes('SECRET'), false);
  assert.ok(args.includes('--header-file'));
  assert.equal(opts.stdio, 'inherit');
  assert.equal(h.errs.join('').includes('SECRET'), false);
});

test('the child environment carries no key and no pointer to one', async () => {
  const h = base();
  assert.equal(await main(h.deps), 0);
  const { env } = h.spawned[0].opts;
  for (const name of SECRET_ENV) assert.equal(name in env, false, `${name} should not reach the child`);
  assert.equal(env.SHORT_IO_PLUGIN_DATA, '/data');
  assert.equal(env.CLAUDE_PLUGIN_ROOT, '/root');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(h.deps.env.SHORT_IO_API_KEY, 'SECRET', 'the launcher env must not be mutated');
});

test('the header file is removed before it is written and again when the child exits', async () => {
  const h = base();
  assert.equal(await main(h.deps), 0);
  assert.deepEqual(h.ops, ['rm', 'write', 'rm']);
  assert.equal(h.rms.length, 2);
  for (const call of h.rms) {
    assert.equal(call.p, HEADERS);
    assert.deepEqual(call.opts, { force: true });
  }
});

test('without a key the launcher exits 2 with the setup hint and spawns nothing', async () => {
  const h = base({ resolve: async () => ({ key: null, source: 'none', configPath: '/cfg' }) });
  assert.equal(await main(h.deps), 2);
  assert.equal(h.writes.length, 0);
  assert.equal(h.spawned.length, 0);
  assert.match(h.errs.join(''), /short-io:setup/);
  assert.match(h.errs.join(''), /\/cfg/);
  assert.deepEqual(h.ops, ['rm']);
});

test('a configuration error exits 2 with the message', async () => {
  const { ConfigError } = await import('../lib/config.mjs');
  const h = base({ resolve: async () => { throw new ConfigError('op read failed: timed out'); } });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /op read failed/);
  assert.equal(h.spawned.length, 0);
});

test('a multi-line key is rejected before anything is written', async () => {
  const h = base({ resolve: async () => ({ key: 'SECRET\nX-Evil: header', source: 'file' }) });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /API key must be a single line/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.rms.length, 0);
  assert.equal(h.spawned.length, 0);
});

test('missing mcp-remote exits 2 with the install hint', async () => {
  const h = base({ exists: () => false });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /install-deps\.sh/);
});

test('a spawn error exits 2, names mcp-remote and still clears the header file', async () => {
  const { spawnImpl } = failingSpawn('spawn ENOENT');
  const h = base({ spawnImpl });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /failed to start mcp-remote/);
  assert.match(h.errs.join(''), /spawn ENOENT/);
  assert.deepEqual(h.ops, ['rm', 'write', 'rm']);
});

test('the child exit code is forwarded', async () => {
  const { spawnImpl } = fakeSpawn(7);
  const h = base({ spawnImpl });
  assert.equal(await main(h.deps), 7);
});

test('the header file name carries the pid, so a second bridge touches only its own', async () => {
  const mine = base({ pid: 111 });
  const theirs = base({ pid: 222 });
  assert.equal(await main(mine.deps), 0);
  assert.equal(await main(theirs.deps), 0);
  assert.equal(mine.writes[0].p, '/data/mcp-remote-111.headers');
  assert.equal(theirs.writes[0].p, '/data/mcp-remote-222.headers');
  for (const call of mine.rms) assert.equal(call.p, '/data/mcp-remote-111.headers');
  for (const call of theirs.rms) assert.equal(call.p, '/data/mcp-remote-222.headers');
  const none = base({ pid: 333, resolve: async () => ({ key: null, source: 'none', configPath: '/cfg' }) });
  assert.equal(await main(none.deps), 2);
  assert.deepEqual(none.rms.map((r) => r.p), ['/data/mcp-remote-333.headers']);
});

const TWO = ['default = "pm"', '[accounts.pm]', 'api_key = "sk_PM"', '[accounts.idd]', 'api_key = "sk_IDD"', 'folders = ["/srv/idd"]'].join('\n');
// The real resolver over fake file text, so these tests pin what the bridge really does.
const bridge = ({ cwd = '/work', config = TWO, env = { SHORT_IO_PLUGIN_DATA: '/data', CLAUDE_PLUGIN_ROOT: '/root', PATH: '/usr/bin' } } = {}) => base({
  env,
  resolve: (d) => resolveBridgeKey({ ...d, homedir: () => '/home/tester', readFile: async () => config, stat: async () => ({ mode: 0o600 }), realpath: async (p) => p, cwd: () => cwd }),
});

test('the bridge writes the key of the account for its working folder', async () => {
  const inside = bridge({ cwd: '/srv/idd/sub' });
  assert.equal(await main(inside.deps), 0);
  assert.equal(inside.writes[0].text, 'Authorization: sk_IDD\n');
  assert.equal(inside.spawned[0].args.join(' ').includes('sk_'), false);
  const elsewhere = bridge();
  assert.equal(await main(elsewhere.deps), 0);
  assert.equal(elsewhere.writes[0].text, 'Authorization: sk_PM\n');
});

test('the bridge writes one line naming the account and the folder rule, never the key', async () => {
  const inside = bridge({ cwd: '/srv/idd/sub' });
  await main(inside.deps);
  assert.equal(inside.errs.length, 1);
  assert.match(inside.errs[0], /account idd/);
  assert.match(inside.errs[0], /folder \/srv\/idd matches \/srv\/idd\/sub/);
  assert.equal(inside.errs.join('').includes('sk_'), false);
});

test('the bridge says when no folder matched and the default answered', async () => {
  const h = bridge();
  await main(h.deps);
  assert.equal(h.errs.length, 1);
  assert.match(h.errs[0], /account pm/);
  assert.match(h.errs[0], /no folder matched, using the default/);
});

test('the bridge refuses on the settings conflict, writing and spawning nothing', async () => {
  const h = bridge({ env: { SHORT_IO_PLUGIN_DATA: '/data', CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY: 'sk_FIELD' } });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /settings field/);
  assert.match(h.errs.join(''), /\[accounts\.<name>\]/);
  assert.equal(h.errs.join('').includes('sk_FIELD'), false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.spawned.length, 0);
});

test('the bridge refuses with no default and no matching folder', async () => {
  const h = bridge({ config: TWO.replace('default = "pm"', '') });
  assert.equal(await main(h.deps), 2);
  assert.match(h.errs.join(''), /no folder matched/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.spawned.length, 0);
});

test('a single-key bridge writes no account line', async () => {
  const h = bridge({ config: 'api_key = "sk_ONE"' });
  assert.equal(await main(h.deps), 0);
  assert.equal(h.writes[0].text, 'Authorization: sk_ONE\n');
  assert.deepEqual(h.errs, []);
});

test('by default the bridge uses the folder-aware resolver', async () => {
  // A real file on disk, because the default resolver is the thing under test. The old
  // resolveKey would let the environment key win here, and the bridge would start.
  const home = await mkdtemp(path.join(tmpdir(), 'short-io-launcher-'));
  try {
    await mkdir(path.join(home, 'short-io-plugin'));
    await writeFile(path.join(home, 'short-io-plugin', 'config.toml'), TWO, { mode: 0o600 });
    const { resolve, ...deps } = base().deps;
    const h = { errs: [] };
    const code = await main({ ...deps, env: { SHORT_IO_PLUGIN_DATA: '/data', SHORT_IO_API_KEY: 'sk_E', XDG_CONFIG_HOME: home }, stderr: { write: (t) => h.errs.push(t) } });
    assert.equal(code, 2);
    assert.match(h.errs.join(''), /settings field/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('by default the bridge reads the real working folder', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'short-io-launcher-'));
  try {
    await mkdir(path.join(home, 'short-io-plugin'));
    const here = await realpath(process.cwd());
    await writeFile(path.join(home, 'short-io-plugin', 'config.toml'), `default = "other"\n[accounts.other]\napi_key = "sk_OTHER"\n[accounts.here]\napi_key = "sk_HERE"\nfolders = ["${here}"]\n`, { mode: 0o600 });
    const h = base({ resolve: undefined, env: { SHORT_IO_PLUGIN_DATA: '/data', XDG_CONFIG_HOME: home } });
    assert.equal(await main(h.deps), 0);
    assert.equal(h.writes[0].text, 'Authorization: sk_HERE\n');
    assert.match(h.errs.join(''), /account here/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
