import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ConfigError, present, parseToml, configPath, readConfigFile, findOp, readOpRef,
  resolveKey, dataDir, OP_TIMEOUT_MS, makeExecOp, opChildEnv, SECRET_ENV, assertKeyShape,
} from '../lib/config.mjs';

const home = () => '/home/tester';
const fileAt = (contents, mode = 0o600) => ({
  readFile: async (p) => { if (p in contents) return contents[p]; const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
  stat: async () => ({ mode }),
});
const CFG = '/home/tester/.config/short-io-plugin/config.toml';

test('present treats empty and user_config placeholders as absent', () => {
  assert.equal(present(undefined), false);
  assert.equal(present('   '), false);
  assert.equal(present('${user_config.short_io_api_key}'), false);
  assert.equal(present('sk_abc'), true);
});

test('parseToml handles quoted, bare, comments and reports skipped lines', () => {
  const { values, skipped } = parseToml(['# c', 'api_key = "sk_1#x"', 'op_account = team.1password.com # t', 'bad line', 'unterminated = "x'].join('\n'));
  assert.deepEqual(values, { api_key: 'sk_1#x', op_account: 'team.1password.com' });
  assert.deepEqual(skipped.map((s) => s.line), [4, 5]);
});

test('configPath honours XDG_CONFIG_HOME', () => {
  assert.equal(configPath({ env: {}, homedir: home }), CFG);
  assert.equal(configPath({ env: { XDG_CONFIG_HOME: '/x' }, homedir: home }), path.join('/x', 'short-io-plugin', 'config.toml'));
});

test('readConfigFile returns exists=false on ENOENT and warns on loose permissions', async () => {
  assert.deepEqual(await readConfigFile({ env: {}, homedir: home, ...fileAt({}) }), { path: CFG, values: {}, sections: [], exists: false });
  const warnings = [];
  const loose = await readConfigFile({ env: {}, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_k"' }, 0o644), warn: (m) => warnings.push(m) });
  assert.equal(loose.values.api_key, 'sk_k');
  assert.match(warnings[0], /chmod 600/);
});

test('assertKeyShape rejects pk_ keys, multi-line and non sk_ values', () => {
  assert.equal(assertKeyShape('sk_abc'), 'sk_abc');
  assert.throws(() => assertKeyShape('pk_abc'), (e) => e instanceof ConfigError && /Public key toggle/.test(e.message));
  assert.throws(() => assertKeyShape('sk_a\nb'), (e) => e instanceof ConfigError && /single line/.test(e.message));
  assert.throws(() => assertKeyShape('abc'), (e) => e instanceof ConfigError && /sk_/.test(e.message));
});

test('resolveKey order - env, plugin option, file api_key, op ref, none', async () => {
  assert.deepEqual(await resolveKey({ env: { SHORT_IO_API_KEY: ' sk_e ' }, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_f"' }) }), { key: 'sk_e', source: 'env' });
  assert.deepEqual(await resolveKey({ env: { CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY: 'sk_opt' }, homedir: home, ...fileAt({}) }), { key: 'sk_opt', source: 'env' });
  assert.deepEqual(await resolveKey({ env: { SHORT_IO_API_KEY: '${user_config.short_io_api_key}' }, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_f"\nop_ref = "op://V/I/f"' }) }), { key: 'sk_f', source: 'file' });
  const calls = [];
  const opHit = await resolveKey({
    env: { SHORT_IO_OP_ACCOUNT: 'team.1password.com' }, homedir: home, ...fileAt({ [CFG]: 'op_ref = "op://Employee/Short.io/credential"' }),
    findOp: () => '/opt/homebrew/bin/op', execOp: async (bin, args) => { calls.push([bin, args]); return 'sk_from_op\n'; },
  });
  assert.deepEqual(opHit, { key: 'sk_from_op', source: 'op' });
  assert.deepEqual(calls[0], ['/opt/homebrew/bin/op', ['read', '--account', 'team.1password.com', '--', 'op://Employee/Short.io/credential']]);
  assert.deepEqual(await resolveKey({ env: {}, homedir: home, ...fileAt({}) }), { key: null, source: 'none', configPath: CFG });
});

test('resolveKey applies the shape check to every source', async () => {
  await assert.rejects(resolveKey({ env: { SHORT_IO_API_KEY: 'pk_public' }, homedir: home, ...fileAt({}) }), (e) => e instanceof ConfigError && /Public key toggle/.test(e.message));
  await assert.rejects(resolveKey({ env: {}, homedir: home, ...fileAt({ [CFG]: 'api_key = "nope"' }) }), (e) => e instanceof ConfigError);
});

test('a configured but broken op step fails loud', async () => {
  await assert.rejects(resolveKey({ env: { SHORT_IO_KEY_OP_REF: 'not-a-ref' }, homedir: home, ...fileAt({}) }), (e) => e instanceof ConfigError && /op:\/\/Vault\/Item\/field/.test(e.message));
  await assert.rejects(readOpRef('op://V/I/f', { findOp: () => null }), (e) => e instanceof ConfigError && /op\) not found/.test(e.message));
  await assert.rejects(readOpRef('op://V/I/f', { findOp: () => '/bin/op', execOp: async () => { throw new Error(`op timed out after ${OP_TIMEOUT_MS} ms`); } }), (e) => /timed out/.test(e.message));
  await assert.rejects(readOpRef('op://V/I/f', { findOp: () => '/bin/op', execOp: async () => '' }), (e) => /empty value/.test(e.message));
});

test('findOp searches PATH then Homebrew and /usr/local', () => {
  assert.equal(findOp({ env: { PATH: '/usr/bin:/bin' }, exists: (p) => p === '/opt/homebrew/bin/op' }), '/opt/homebrew/bin/op');
  assert.equal(findOp({ env: { PATH: '' }, exists: () => false }), null);
});

test('dataDir prefers SHORT_IO_PLUGIN_DATA, then CLAUDE_PLUGIN_DATA, then the default', () => {
  assert.equal(dataDir({ env: { SHORT_IO_PLUGIN_DATA: '/d1', CLAUDE_PLUGIN_DATA: '/d2' } }), '/d1');
  assert.equal(dataDir({ env: { CLAUDE_PLUGIN_DATA: '/d2' } }), '/d2');
  assert.equal(dataDir({ env: {}, homedir: home }), '/home/tester/.claude/plugins/data/short-io');
});

test('the op child process inherits no key and no pointer to one', async () => {
  const seen = [];
  const env = { PATH: '/usr/bin', SHORT_IO_API_KEY: 'sk_S', SHORT_IO_KEY_OP_REF: 'op://V/I/f', SHORT_IO_OP_ACCOUNT: 'a', CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY: 'sk_S' };
  const execOp = makeExecOp({ execFileImpl: (bin, args, options, cb) => { seen.push({ bin, args, options }); cb(null, 'sk_x\n', ''); }, env });
  assert.equal(await execOp('/bin/op', ['read', '--', 'op://V/I/f']), 'sk_x');
  for (const name of SECRET_ENV) assert.equal(name in seen[0].options.env, false, `${name} should not reach op`);
  assert.equal(seen[0].options.env.PATH, '/usr/bin');
  assert.equal(env.SHORT_IO_API_KEY, 'sk_S');
  assert.equal(seen[0].options.timeout, OP_TIMEOUT_MS);
  assert.equal('SHORT_IO_API_KEY' in opChildEnv({ SHORT_IO_API_KEY: 'x', PATH: '/p' }), false);
});

test('parseToml keeps section keys out of the top level', () => {
  const { values, sections } = parseToml(['default = "b"', '[accounts.a]', 'api_key = "sk_a"', '[accounts.b] # the second', 'api_key = "sk_b"', 'op_account = team.1password.com # t'].join('\n'));
  assert.deepEqual(values, { default: 'b' });
  assert.deepEqual(sections.map((s) => [s.name, s.line, s.values]), [['a', 2, { api_key: 'sk_a' }], ['b', 4, { api_key: 'sk_b', op_account: 'team.1password.com' }]]);
});

test('parseToml reads folders as a string or a one-line array', () => {
  const folders = (line) => parseToml(`[accounts.a]\n${line}`).sections[0].values.folders;
  assert.equal(folders('folders = "~/code/one"'), '~/code/one');
  assert.deepEqual(folders('folders = ["~/one", "/two/with, comma"]'), ['~/one', '/two/with, comma']);
  assert.deepEqual(folders('folders = [ "~/one", ] # trailing comma and comment'), ['~/one']);
  assert.deepEqual(folders('folders = []'), []);
  assert.deepEqual(folders('folders = [ ]'), []);
});

test('parseToml reports an unreadable folders value with its section', () => {
  const { skipped, sections } = parseToml('[accounts.a]\nfolders = [\n"~/one",\n]');
  assert.deepEqual(skipped.map((s) => [s.line, s.key, s.section]), [[2, 'folders', 'a'], [3, undefined, 'a'], [4, undefined, 'a']]);
  assert.equal('folders' in sections[0].values, false);
});

test('parseToml reads an array only for folders in a section', () => {
  const top = parseToml('folders = ["~/one"]');
  assert.deepEqual(top.values, {});
  assert.equal(top.skipped[0].line, 1);
  const other = parseToml('[accounts.a]\napi_key = ["sk_a"]');
  assert.deepEqual(other.sections[0].values, {});
  assert.equal(other.skipped[0].key, 'api_key');
});

test('parseToml records a repeated key in a section', () => {
  const { sections } = parseToml('[accounts.a]\napi_key = "sk_1"\napi_key = "sk_2"');
  assert.deepEqual(sections[0].repeats, ['api_key']);
});

test('the top level keeps its 0.1.0 last-one-wins rule', () => {
  const { values } = parseToml('api_key = "sk_1"\napi_key = "sk_2"');
  assert.deepEqual(values, { api_key: 'sk_2' });
});

test('parseToml skips any other section and keeps its keys out', () => {
  for (const header of ['[other]', '[accounts.a.b]', '[[accounts.x]]', '[accounts.]', '[accounts."x"]', '[accounts.a b]', '[accounts.a] trailing']) {
    const { values, sections, ignored, skipped } = parseToml(`default = "z"\n${header}\napi_key = "sk_stray"\nfolders = ["x"]`);
    assert.deepEqual(values, { default: 'z' }, header);
    assert.deepEqual(sections, [], header);
    assert.deepEqual(ignored, [2], header);
    assert.deepEqual(skipped, [], header);
  }
});

test('a section after a skipped one reads normally', () => {
  const { sections } = parseToml('[other]\napi_key = "sk_stray"\n[accounts.a]\napi_key = "sk_a"');
  assert.deepEqual(sections.map((s) => s.values), [{ api_key: 'sk_a' }]);
});

test('readConfigFile warns about skipped lines and sections by number and never echoes a line', async () => {
  const warnings = [];
  const out = await readConfigFile({ env: {}, homedir: home, ...fileAt({ [CFG]: '[accounts.a]\napi_key = "sk_SECRET\n[other]\napi_key = "sk_SECRET2"' }), warn: (m) => warnings.push(m) });
  assert.deepEqual(out.sections.map((s) => s.name), ['a']);
  assert.equal(warnings.some((w) => /line 2/.test(w)), true);
  assert.equal(warnings.some((w) => /line 3/.test(w) && /\[accounts\.<name>\]/.test(w)), true);
  assert.equal(warnings.join('\n').includes('sk_SECRET'), false);
});
