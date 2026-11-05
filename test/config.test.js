import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ConfigError, present, parseToml, configPath, readConfigFile, findOp, readOpRef,
  resolveKey, dataDir, OP_TIMEOUT_MS, makeExecOp, opChildEnv, SECRET_ENV, assertKeyShape,
  loadAccounts, matchFolder, routingOrder, resolveBridgeKey,
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

const TWO = ['default = "pm"', '[accounts.pm]', 'api_key = "sk_PM"', '[accounts.idd]', 'api_key = "sk_IDD"', 'folders = ["~/code/idd-world", "/srv/idd"]'].join('\n');
const load = (text, over = {}) => loadAccounts({ env: {}, homedir: home, ...fileAt({ [CFG]: text }), realpath: async (p) => p, cwd: () => '/work', ...over });
const refuses = (text, pattern, over = {}) => assert.rejects(load(text, over), (e) => e instanceof ConfigError && pattern.test(e.message));

test('a single-key file is one account named default, as 0.1.0 read it', async () => {
  const m = await load('api_key = "sk_f"');
  assert.equal(m.named, false);
  assert.deepEqual(m.accounts, [{ name: 'default', folders: [] }]);
  assert.equal(m.default, 'default');
  assert.equal(m.folderAccount, 'default');
  assert.equal(m.folder, '/work');
  assert.equal(m.file.values.api_key, 'sk_f');
});

test('no config file at all is still the single-key path', async () => {
  const m = await loadAccounts({ env: {}, homedir: home, ...fileAt({}), cwd: () => '/work' });
  assert.equal(m.named, false);
  assert.equal(m.file.exists, false);
});

test('a deleted working folder does not trouble a single-key setup', async () => {
  const m = await load('api_key = "sk_f"', { cwd: () => { throw new Error('ENOENT uv_cwd'); } });
  assert.equal(m.folder, null);
  assert.equal(m.folderAccount, 'default');
});

test('the settings field is not a conflict for a single-key file', async () => {
  const m = await load('api_key = "sk_f"', { env: { SHORT_IO_API_KEY: 'sk_e' } });
  assert.equal(m.named, false);
});

test('named accounts load with their folders expanded and the default named', async () => {
  const m = await load(TWO);
  assert.equal(m.named, true);
  assert.deepEqual(m.accounts.map((a) => [a.name, a.folders]), [['pm', []], ['idd', ['/home/tester/code/idd-world', '/srv/idd']]]);
  assert.equal(m.default, 'pm');
});

test('folders may be a plain string, and a bare ~ is the home folder', async () => {
  const m = await load('[accounts.a]\napi_key = "sk_a"\nfolders = "~/one"\n[accounts.b]\napi_key = "sk_b"\nfolders = ["~"]');
  assert.deepEqual(m.accounts.map((a) => a.folders), [['/home/tester/one'], ['/home/tester']]);
});

test('default may be left out with one account', async () => {
  const m = await load('[accounts.only]\napi_key = "sk_a"');
  assert.equal(m.default, 'only');
  assert.equal(m.folderAccount, 'only');
  assert.equal(m.rule, 'no folder matched, using the default');
});

test('an account name is only a name, __proto__ included', async () => {
  const m = await load('[accounts.__proto__]\napi_key = "sk_a"');
  assert.deepEqual(m.accounts.map((a) => a.name), ['__proto__']);
  assert.equal(m.accounts[0].values.api_key, 'sk_a');
});

test('error - a top-level key beside account sections', async () => {
  await refuses('api_key = "sk_t"\n[accounts.a]\napi_key = "sk_a"', /top-level.*\[accounts\.<name>\]/s);
  await refuses('op_ref = "op://V/I/f"\n[accounts.a]\napi_key = "sk_a"', /top-level.*\[accounts\.<name>\]/s);
});

test('error - default names an account that does not exist', async () => {
  await refuses('default = "nope"\n[accounts.a]\napi_key = "sk_a"', /default.*"nope".*Accounts: a/s);
});

test('error - an account with neither api_key nor op_ref', async () => {
  await refuses('[accounts.empty]', /\[accounts\.empty\].*api_key.*op_ref/s);
  await refuses('[accounts.blank]\napi_key = ""', /\[accounts\.blank\].*api_key.*op_ref/s);
});

test('error - the same folder under two accounts, also through a symlink', async () => {
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = "/x"\n[accounts.b]\napi_key = "sk_b"\nfolders = "/x"', /\/x.*\[accounts\.a\].*\[accounts\.b\]/s);
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = "/x"\n[accounts.b]\napi_key = "sk_b"\nfolders = "/link"', /\/x.*\[accounts\.a\].*\[accounts\.b\]/s, { realpath: async (p) => (p === '/link' ? '/x' : p) });
});

test('the same folder twice under one account is harmless', async () => {
  const m = await load('[accounts.a]\napi_key = "sk_a"\nfolders = ["/x", "/x/"]');
  assert.deepEqual(m.accounts[0].folders, ['/x']);
});

test('error - each settings variable beside account sections, by name and never by value', async () => {
  assert.equal(SECRET_ENV.length, 6);
  for (const name of SECRET_ENV) {
    await assert.rejects(load(TWO, { env: { [name]: 'sk_VALUE' } }), (e) => e instanceof ConfigError && e.message.includes(name) && /settings field/.test(e.message) && /\[accounts\.<name>\]/.test(e.message) && !e.message.includes('sk_VALUE'));
  }
});

test('a blank or unexpanded settings field is no conflict', async () => {
  assert.equal((await load(TWO, { env: { SHORT_IO_API_KEY: '', CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY: '  ', SHORT_IO_KEY_OP_REF: '${user_config.short_io_key_op_ref}' } })).named, true);
});

test('error - an unreadable folders value, so a session cannot quietly reach the default', async () => {
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = [\n"/x",\n]', /line 3.*folders/s);
  await refuses("[accounts.a]\napi_key = \"sk_a\"\nfolders = ['/x']", /line 3.*folders/s);
});

test('error - a folder that is not absolute, which would match the working folder', async () => {
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = ["code/x"]', /"code\/x".*~/s);
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = [""]', /"".*~/s);
  await refuses('[accounts.a]\napi_key = "sk_a"\nfolders = ["~other/x"]', /"~other\/x"/);
});

test('error - two keys competing inside the file', async () => {
  await refuses('[accounts.a]\napi_key = "sk_1"\napi_key = "sk_2"', /\[accounts\.a\].*api_key.*twice/s);
  await refuses('[accounts.a]\napi_key = "sk_1"\n[accounts.a]\napi_key = "sk_2"', /\[accounts\.a\].*twice/s);
});

test('none of the errors repeats a key', async () => {
  for (const text of ['api_key = "sk_SEEN"\n[accounts.a]\napi_key = "sk_SEEN"', '[accounts.a]\napi_key = "sk_SEEN"\napi_key = "sk_SEEN"', '[accounts.a]\napi_key = "sk_SEEN"\n[accounts.a]\napi_key = "sk_SEEN"']) {
    await assert.rejects(load(text), (e) => !e.message.includes('sk_SEEN'));
  }
});

test('a key a section does not take is ignored with a warning by line number', async () => {
  const warnings = [];
  const m = await load('[accounts.a]\napi_key = "sk_a"\nsk_oops = "sk_SEEN"', { warn: (w) => warnings.push(w) });
  assert.equal('sk_oops' in m.accounts[0].values, false);
  assert.match(warnings.join('\n'), /line 3/);
  assert.equal(warnings.join('\n').includes('sk_'), false);
});

test('a top-level op_account beside sections warns, because it reaches no account', async () => {
  const warnings = [];
  await load('op_account = "team.1password.com"\n[accounts.a]\napi_key = "sk_a"', { warn: (w) => warnings.push(w) });
  assert.match(warnings.join('\n'), /op_account.*\[accounts\.<name>\]/s);
});

test('a configured folder that does not exist warns and the rest still loads', async () => {
  const warnings = [];
  const m = await load('[accounts.a]\napi_key = "sk_a"\nfolders = "/gone"', { warn: (w) => warnings.push(w), realpath: async (p) => { if (p === '/gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return p; } });
  assert.deepEqual(m.accounts[0].folders, ['/gone']);
  assert.match(warnings.join('\n'), /\/gone.*\[accounts\.a\]/s);
});

test('matchFolder matches on a path boundary and the longest folder wins', () => {
  const a = { name: 'a', folders: ['/a/b'] };
  const b = { name: 'b', folders: ['/a/b/c', '/z'] };
  assert.equal(matchFolder('/a/b', [a, b]).account.name, 'a');
  assert.equal(matchFolder('/a/b/x', [a, b]).account.name, 'a');
  assert.equal(matchFolder('/a/b/c', [a, b]).account.name, 'b');
  assert.equal(matchFolder('/a/b/c/d', [b, a]).account.name, 'b');
  assert.equal(matchFolder('/a/b/c/d', [a, b]).folder, '/a/b/c');
  assert.equal(matchFolder('/a/bc', [a, b]), null);
  assert.equal(matchFolder('/q', [a, b]), null);
  assert.equal(matchFolder('/anything', [{ name: 'root', folders: ['/'] }]).account.name, 'root');
});

test('the working folder picks the account, after resolving symlinks', async () => {
  const inside = await load(TWO, { cwd: () => '/home/tester/code/idd-world/sub' });
  assert.equal(inside.folderAccount, 'idd');
  assert.match(inside.rule, /\/home\/tester\/code\/idd-world/);
  const linked = await load(TWO, { cwd: () => '/link/sub', realpath: async (p) => (p === '/link/sub' ? '/srv/idd/sub' : p) });
  assert.equal(linked.folderAccount, 'idd');
  assert.equal(linked.folder, '/srv/idd/sub');
  const trailing = await load('default = "b"\n[accounts.a]\napi_key = "sk_a"\nfolders = "/w/"\n[accounts.b]\napi_key = "sk_b"', { cwd: () => '/w/x' });
  assert.equal(trailing.folderAccount, 'a');
});

test('no folder match uses the default and says so', async () => {
  const m = await load(TWO, { cwd: () => '/elsewhere' });
  assert.equal(m.folderAccount, 'pm');
  assert.equal(m.rule, 'no folder matched, using the default');
});

test('no match and no default leaves no folder account', async () => {
  const m = await load('[accounts.a]\napi_key = "sk_a"\n[accounts.b]\napi_key = "sk_b"');
  assert.equal(m.default, undefined);
  assert.equal(m.folderAccount, null);
});

test('routingOrder is the folder account, then the default, then file order, each once', async () => {
  const text = 'default = "b"\n[accounts.a]\napi_key = "sk_a"\n[accounts.b]\napi_key = "sk_b"\n[accounts.c]\napi_key = "sk_c"\nfolders = "/c"';
  const names = (m) => routingOrder(m).map((a) => a.name);
  assert.deepEqual(names(await load(text, { cwd: () => '/c/x' })), ['c', 'b', 'a']);
  assert.deepEqual(names(await load(text, { cwd: () => '/q' })), ['b', 'a', 'c']);
  assert.deepEqual(names(await load('[accounts.a]\napi_key = "sk_a"\n[accounts.b]\napi_key = "sk_b"')), ['a', 'b']);
});

test('resolveKey reads a named account from its section, with the shape check', async () => {
  const account = (values) => ({ name: 'a', folders: [], values });
  assert.deepEqual(await resolveKey({ env: {}, account: account({ api_key: ' sk_a ' }) }), { key: 'sk_a', source: 'file' });
  assert.deepEqual(await resolveKey({ env: {}, account: account({ api_key: 'sk_a', op_ref: 'op://V/I/f' }) }), { key: 'sk_a', source: 'file' });
  await assert.rejects(resolveKey({ env: {}, account: account({ api_key: 'pk_a' }) }), (e) => e instanceof ConfigError && /Public key toggle/.test(e.message));
  const calls = [];
  const op = await resolveKey({ env: {}, account: account({ op_ref: 'op://V/I/f', op_account: 'team.1password.com' }), findOp: () => '/bin/op', execOp: async (bin, args) => { calls.push(args); return 'sk_op\n'; } });
  assert.deepEqual(op, { key: 'sk_op', source: 'op' });
  assert.deepEqual(calls[0], ['read', '--account', 'team.1password.com', '--', 'op://V/I/f']);
});

test('resolveKey takes an already read file, so it reads and warns once', async () => {
  const unread = { readFile: async () => { throw new Error('read twice'); } };
  const out = await resolveKey({ env: {}, homedir: home, ...unread, file: { path: CFG, values: { api_key: 'sk_f' } } });
  assert.deepEqual(out, { key: 'sk_f', source: 'file' });
  assert.deepEqual(await resolveKey({ env: { SHORT_IO_API_KEY: 'sk_e' }, ...unread, file: { path: CFG, values: { api_key: 'sk_f' } } }), { key: 'sk_e', source: 'env' });
  assert.deepEqual(await resolveKey({ env: {}, ...unread, account: { name: 'default', folders: [] }, file: { path: CFG, values: {} } }), { key: null, source: 'none', configPath: CFG });
});

test('resolveBridgeKey keeps the single-key chain and adds nothing to its answer', async () => {
  assert.deepEqual(await resolveBridgeKey({ env: { SHORT_IO_API_KEY: 'sk_e' }, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_f"' }), cwd: () => '/work' }), { key: 'sk_e', source: 'env' });
  assert.deepEqual(await resolveBridgeKey({ env: {}, homedir: home, ...fileAt({}), cwd: () => '/work' }), { key: null, source: 'none', configPath: CFG });
});

test('resolveBridgeKey picks the folder account and names the rule', async () => {
  const deps = (cwd) => ({ env: {}, homedir: home, ...fileAt({ [CFG]: TWO }), realpath: async (p) => p, cwd: () => cwd });
  const idd = await resolveBridgeKey(deps('/srv/idd/x'));
  assert.equal(idd.key, 'sk_IDD'); assert.equal(idd.account, 'idd'); assert.match(idd.rule, /\/srv\/idd/);
  const pm = await resolveBridgeKey(deps('/elsewhere'));
  assert.equal(pm.key, 'sk_PM'); assert.equal(pm.account, 'pm'); assert.equal(pm.rule, 'no folder matched, using the default');
});

test('resolveBridgeKey refuses with no default and no matching folder', async () => {
  const deps = { env: {}, homedir: home, ...fileAt({ [CFG]: '[accounts.a]\napi_key = "sk_a"\n[accounts.b]\napi_key = "sk_b"' }), realpath: async (p) => p, cwd: () => '/work' };
  await assert.rejects(resolveBridgeKey(deps), (e) => e instanceof ConfigError && /\/work/.test(e.message) && /default/.test(e.message) && /a, b/.test(e.message));
});

test('an environment key needs no readable config file, as in 0.1.0', async () => {
  const unreadable = { readFile: async () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); }, stat: async () => ({ mode: 0o600 }) };
  for (const name of ['SHORT_IO_API_KEY', 'CLAUDE_PLUGIN_OPTION_SHORT_IO_API_KEY']) {
    const warnings = [];
    const deps = { env: { [name]: 'sk_E' }, homedir: home, ...unreadable, cwd: () => '/work', warn: (m) => warnings.push(m) };
    assert.equal((await loadAccounts(deps)).named, false);
    assert.deepEqual(await resolveBridgeKey(deps), { key: 'sk_E', source: 'env' });
    assert.match(warnings[0], /Cannot read/);
    assert.equal(warnings.join('').includes('sk_E'), false);
  }
});

test('with no environment key an unreadable file still stops, as in 0.1.0', async () => {
  const unreadable = { readFile: async () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }); }, stat: async () => ({ mode: 0o600 }) };
  await assert.rejects(loadAccounts({ env: {}, homedir: home, ...unreadable, cwd: () => '/work' }), (e) => e instanceof ConfigError && /Cannot read/.test(e.message));
  await assert.rejects(loadAccounts({ env: { SHORT_IO_KEY_OP_REF: 'op://V/I/f' }, homedir: home, ...unreadable, cwd: () => '/work' }), (e) => e instanceof ConfigError && /Cannot read/.test(e.message));
});

test('an environment key keeps a single-key file silent, as in 0.1.0', async () => {
  const warnings = [];
  const m = await loadAccounts({ env: { SHORT_IO_API_KEY: 'sk_E' }, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_F"\nbad line\n[other]' }, 0o644), cwd: () => '/work', warn: (w) => warnings.push(w) });
  assert.equal(m.named, false);
  assert.deepEqual(warnings, []);
  const without = [];
  await loadAccounts({ env: {}, homedir: home, ...fileAt({ [CFG]: 'api_key = "sk_F"' }, 0o644), cwd: () => '/work', warn: (w) => without.push(w) });
  assert.match(without[0], /chmod 600/);
});

test('an environment key beside named accounts is still the conflict, loose mode or not', async () => {
  await assert.rejects(loadAccounts({ env: { SHORT_IO_API_KEY: 'sk_E' }, homedir: home, ...fileAt({ [CFG]: TWO }, 0o644), cwd: () => '/work' }), (e) => e instanceof ConfigError && /settings field/.test(e.message));
});

test('a key pasted into the wrong place does not come back out in an error', async () => {
  await assert.rejects(load('default = "sk_LEAK"\n[accounts.pm]\napi_key = "sk_PM"'), (e) => e instanceof ConfigError && /default/.test(e.message) && /Accounts: pm/.test(e.message) && !e.message.includes('sk_LEAK'));
  await assert.rejects(load('[accounts.pm]\napi_key = "sk_PM"\nfolders = ["sk_LEAK"]'), (e) => e instanceof ConfigError && /\[accounts\.pm\]/.test(e.message) && !e.message.includes('sk_LEAK'));
  await assert.rejects(load('default = "pk_LEAK"\n[accounts.pm]\napi_key = "sk_PM"'), (e) => !e.message.includes('pk_LEAK'));
});

test('a deleted working folder with named accounts says what to do', async () => {
  await assert.rejects(load(TWO, { cwd: () => { throw new Error('ENOENT: uv_cwd'); } }), (e) => e instanceof ConfigError && /working folder/.test(e.message) && /Run this from a folder that exists/.test(e.message));
});
