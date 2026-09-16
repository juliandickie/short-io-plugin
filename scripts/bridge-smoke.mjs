#!/usr/bin/env node
// Bridge smoke - proves the hosted MCP bridge actually answers a tool call, not merely that
// the launcher starts. Spawns scripts/run-mcp.mjs exactly as Claude Code would, speaks MCP
// over its stdio (newline-delimited JSON-RPC), lists the tools and calls get-domains.
//
// The key is never read here. The launcher resolves it through the shared chain and writes
// its own short-lived header file, so this script sees hostnames and nothing else, and the
// output is safe to paste into a smoke record. Exits 0 on success, 1 with the reason
// otherwise, and always kills the child.
//
// Usage: node scripts/bridge-smoke.mjs      (from anywhere - paths are derived)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = process.env.SHORT_IO_PLUGIN_DATA ?? '/tmp/sio-data';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'short-io-bridge-smoke', version: '0.1.0' };
const STARTUP_MS = 45000;
const CALL_MS = 30000;

function start() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-mcp.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, SHORT_IO_PLUGIN_DATA: DATA },
  });
  const pending = new Map();      // id -> {resolve, reject}
  const stderr = [];
  let buffer = '';
  let exited = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // mcp-remote banners are not JSON-RPC
      const waiter = msg.id !== undefined && pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message ?? 'error'} (code ${msg.error.code ?? '?'})`));
      else waiter.resolve(msg.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('exit', (code) => {
    exited = code;
    for (const [, waiter] of pending) waiter.reject(new Error(`the bridge exited with code ${code} before answering`));
    pending.clear();
  });

  let nextId = 1;
  const send = (obj) => { child.stdin.write(`${JSON.stringify(obj)}\n`); };
  const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    if (exited !== null) { reject(new Error(`the bridge exited with code ${exited}`)); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  return { child, request, notify, stderr };
}

// The tool answers with content blocks; the hostnames are whatever the payload calls them,
// and ids are deliberately never pulled out of it.
function hostnames(result) {
  const texts = (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text);
  const payloads = [result?.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return null; } })];
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.hostname === 'string') found.add(node.hostname);
    for (const value of Object.values(node)) walk(value);
  };
  payloads.forEach(walk);
  return [...found].sort();
}

async function main() {
  const { child, request, notify, stderr } = start();
  try {
    const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, STARTUP_MS);
    notify('notifications/initialized', {});
    const server = init?.serverInfo ? `${init.serverInfo.name ?? '?'} ${init.serverInfo.version ?? ''}`.trim() : 'unnamed server';
    const { tools = [] } = await request('tools/list', {}, CALL_MS);
    const called = await request('tools/call', { name: 'get-domains', arguments: {} }, CALL_MS);
    if (called?.isError) throw new Error(`get-domains answered isError: ${JSON.stringify(called.content ?? '').slice(0, 300)}`);
    const hosts = hostnames(called);
    process.stdout.write([
      `server: ${server}, protocol ${init?.protocolVersion ?? '?'}`,
      `tools: ${tools.length}`,
      `tool names: ${tools.map((t) => t.name).sort().join(', ')}`,
      `get-domains hostnames (${hosts.length}): ${hosts.join(', ') || '(none returned)'}`,
      'ok',
      '',
    ].join('\n'));
    return 0;
  } catch (error) {
    const tail = stderr.join('').trim().split('\n').slice(-5).join('\n');
    process.stderr.write(`bridge smoke FAILED: ${error.message}\n${tail ? `last stderr:\n${tail}\n` : ''}`);
    return 1;
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`bridge smoke FAILED: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
