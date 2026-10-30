#!/usr/bin/env node
// Aimiru for Claude Code: Aimiru's own tools (get_answer, record, take_task and the rest) for the
// Claude Code that runs this plugin (ADR-0043, hardened in ADR-0052).
//
// Claude Code starts this script as the plugin's tool server and talks to it over stdin and stdout
// (one JSON-RPC message per line). Each message goes to <Aimiru address>/mcp with the key, and the
// answers come back the same way. The key and the address are read exactly as the hooks read them
// (loadSettings in lib/runtime.mjs): the plugin's key setting when the person filled it in, else
// the key file /aimiru:connect saved when the person connected by pairing. So a Claude Code
// connected by pairing can use Aimiru's tools too (before, the server took its key from the setting
// alone, which pairing leaves empty, and every tool answered 401).
//
// They are read again for every message, so connecting in the middle of a session works without a
// restart: until then the server says it is not connected and lists no tools, and once the key
// file appears it tells Claude Code the list changed.
//
// Both protocol eras: the 2025 one (initialize first) and 2026-07-28 (Claude Code 2.1.306: an
// envelope on every message, server/discover, and a listening request that stays open, answered
// here; see createToolServer). An answer Aimiru sends as an event stream is passed on message by
// message as it arrives, never by waiting for the stream to end.
//
// The start never fails (live run, 22 Oct 2026): Claude Code 2.1.306 remembers a tool server whose
// start failed and leaves it out of every new session for 15 minutes. So while Aimiru cannot be
// reached (or refuses the key), the start is answered here with no tools, Aimiru is tried again in
// the background, and Claude Code is told the tools changed once it answers.
//
// A key read from the file goes only to the address it was made for. Never prints the key.

import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findDataDir, loadSettings, VERSION } from './lib/runtime.mjs';
import { normaliseBaseUrl, setting } from './vendor/aimiru-client.mjs';
import { CLAUDE_CODE_CONNECT, MESSAGES, undoLineFor } from './vendor/messages.mjs';

/** How long one message may take on the network. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How long the start (and a tool list) waits for Aimiru before it is answered here instead. */
export const START_TIMEOUT_MS = 10_000;
/** How often Aimiru is tried again after it could not be reached at the start. */
export const RETRY_MS = 15_000;
/** How often an unconnected server looks for the key /aimiru:connect saves. */
export const WATCH_MS = 2_000;

/** The JSON-RPC error codes this bridge answers with itself. */
export const NOT_CONNECTED = -32001;
export const UNREACHABLE = -32002;

export const TOOL_SERVER_MESSAGES = {
  // Wave 10, snag 4: the key the person was given first, pairing second.
  notConnected: `Aimiru for Claude Code is not connected yet. ${CLAUDE_CODE_CONNECT}`,
  instructionsNotConnected: `Aimiru's tools appear here once this Claude Code is connected to Aimiru. ${CLAUDE_CODE_CONNECT}`,
  instructionsUnreachable:
    "Aimiru could not be reached when this session started. Aimiru's tools appear here once it answers, with no restart.",
  instructionsKeyRefused:
    "Aimiru did not accept the key this computer has. Run /aimiru:connect --again, and Aimiru's tools appear here.",
  keyRefused: 'Aimiru did not accept the key this computer has. Run /aimiru:connect --again.',
  // Wave 10, snag 12: the key belonged to a demo whose time is over.
  demoEnded: MESSAGES.demoEnded(undoLineFor('claude-code')),
  unreachable: 'Aimiru could not be reached. Try again in a minute.',
};

/** True when a 401 answer is Aimiru saying the demo has ended (code demo_ended); reads the body. */
async function demoEndedAnswer(res) {
  try {
    const body = JSON.parse(await res.text());
    return body?.error?.code === 'demo_ended';
  } catch {
    return false;
  }
}

/** A value Claude Code left as written ("${user_config.agent_key}") counts as not set. */
function given(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '' || /^\$\{[^}]*\}$/.test(v)) return undefined;
  return v;
}

/**
 * The environment loadSettings reads, from the one Claude Code gives this server: its exported
 * CLAUDE_PLUGIN_* values, or the plugin.json env entries (AIMIRU_PLUGIN_*) where those are missing,
 * and the plugin's data folder found the way /aimiru:connect finds it when neither names one.
 */
export function toolServerEnv(env = process.env) {
  const out = { ...env };
  for (const name of ['CLAUDE_PLUGIN_OPTION_AGENT_KEY', 'CLAUDE_PLUGIN_OPTION_AIMIRU_URL', 'CLAUDE_PLUGIN_DATA']) {
    if (given(out[name]) === undefined) delete out[name];
  }
  const key = given(env.CLAUDE_PLUGIN_OPTION_AGENT_KEY) ?? given(env.AIMIRU_PLUGIN_AGENT_KEY);
  const url = given(env.CLAUDE_PLUGIN_OPTION_AIMIRU_URL) ?? given(env.AIMIRU_PLUGIN_URL);
  if (key) out.CLAUDE_PLUGIN_OPTION_AGENT_KEY = key;
  if (url) out.CLAUDE_PLUGIN_OPTION_AIMIRU_URL = url;
  delete out.AIMIRU_PLUGIN_AGENT_KEY;
  const dataDir = given(env.CLAUDE_PLUGIN_DATA) ?? given(env.AIMIRU_PLUGIN_DATA);
  out.CLAUDE_PLUGIN_DATA = dataDir ?? findDataDir(out);
  return out;
}

/** Where to send messages and with which key, or null while this Claude Code is not connected. */
export function connection(env = process.env) {
  const settings = loadSettings(toolServerEnv(env));
  if (!settings.token || !settings.baseUrl) return null;
  try {
    return { endpoint: `${normaliseBaseUrl(settings.baseUrl)}/mcp`, token: settings.token };
  } catch {
    // An address that is not https (or this computer): the key never goes there.
    return null;
  }
}

const isRequest = (m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const isNotification = (m) => m && typeof m === 'object' && typeof m.method === 'string' && (m.id === undefined || m.id === null);
/** An answer to a request: a result or an error for its id. */
const isAnswer = (m, id) => m && typeof m === 'object' && m.id === id && (m.result !== undefined || m.error !== undefined);

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The protocol version a message names in its own envelope (the 2026 era), if any. */
function envelopeVersion(message) {
  const v = message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' ? v : null;
}

/** The JSON-RPC message in one event of an event stream, or null. */
function eventMessage(block) {
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null; // not a message
  }
}

/**
 * The JSON-RPC messages of an event stream body, each as soon as it arrives. An event stream may
 * stay open after the last message (keep-alives), so it is never read to its end first; stopping
 * the loop lets the stream go.
 */
async function* eventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let gap;
      while ((gap = /\r?\n\r?\n/.exec(buf))) {
        const message = eventMessage(buf.slice(0, gap.index));
        buf = buf.slice(gap.index + gap[0].length);
        if (message) yield message;
      }
    }
    const last = eventMessage(buf + decoder.decode());
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The protocol revisions this bridge answers server/discover with while it is not connected. */
export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
/**
 * Requests Claude Code makes to start this server and list its tools. They never fail: when Aimiru
 * does not answer them, this bridge does, with no tools (see createToolServer).
 */
const START_METHODS = new Set(['initialize', 'server/discover', 'tools/list', 'ping']);
/** The `_meta` key naming the listening request a notification is delivered on (MCP 2026-07-28). */
export const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

/**
 * The bridge. `write` takes one message object; `fetch` and `env` are injectable for tests.
 * Returns {handle(line), close()}.
 *
 * Two requests are answered here and never sent to Aimiru (MCP 2026-07-28, Claude Code 2.1.306):
 * - subscriptions/listen stays open for the whole session. Aimiru keeps nothing between messages,
 *   so its own listen only ever acknowledges and then keeps the line open; waiting for that reply
 *   to end held every session start for about 29 s and lost Aimiru's tools. This bridge
 *   acknowledges it at once with what it can deliver (that the tool list changed, when the key
 *   /aimiru:connect saves appears) and keeps it open.
 * - notifications/cancelled ends a listen, or stops a request still on its way to Aimiru. Nothing
 *   is written for a cancelled id afterwards: Claude Code reads an answer to an id it cancelled as
 *   a broken connection.
 *
 * And the start never fails (START_METHODS): when Aimiru cannot be reached, answers with an error
 * or refuses the key, the start and the tool list are answered here with no tools, Aimiru is tried
 * again every `retryMs` (a refused key only once the key changes), and the tool list changed is
 * said once it answers. Claude Code 2.1.306 caches a failed start for 15 minutes and leaves the
 * server out of every new session meanwhile, so failing it would hide Aimiru's tools long after
 * Aimiru is back (live run, 22 Oct 2026).
 */
export function createToolServer({
  write,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  watchMs = WATCH_MS,
  retryMs = RETRY_MS,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  let protocolVersion = null;
  /** True once Claude Code speaks the 2026 era (an envelope on its messages, or a listen). */
  let modern = false;
  /** The envelope Claude Code last sent, reused when Aimiru is tried again on its own. */
  let lastMeta = null;
  let watcher = null;
  let retrier = null;
  let probing = false;
  /** The key Aimiru refused at the start: not sent again on its own until the key changes. */
  let refusedKey = null;
  /** A tool list changed notice that found no listen to go on: said on the next listen. */
  let owedNotice = false;
  /** Open listening requests, by their id: what each asked for and this bridge agreed to send. */
  const listens = new Map();
  /** Requests on their way to Aimiru, by their id. */
  const inFlight = new Map();

  const stopWatching = () => {
    if (watcher) clearInterval(watcher);
    watcher = null;
  };

  const stopRetrying = () => {
    if (retrier) clearInterval(retrier);
    retrier = null;
  };

  /** The tool list changed: said on each listen that asked for it, or on its own in the 2025 era. */
  const announceToolsChanged = () => {
    let said = false;
    for (const [id, honoured] of listens) {
      if (!honoured.toolsListChanged) continue;
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [SUBSCRIPTION_ID]: id } } });
      said = true;
    }
    if (!said && !modern) {
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      said = true;
    }
    owedNotice = !said;
  };

  // Not connected when Claude Code started this server: look for the key, and say the tools changed once it is there.
  const watchForKey = () => {
    if (watcher || watchMs <= 0) return;
    watcher = setInterval(() => {
      if (connection(env)) {
        stopWatching();
        announceToolsChanged();
      }
    }, watchMs);
    watcher.unref?.();
  };

  /** subscriptions/listen: acknowledged here at once and kept open (see above). */
  const answerListen = (message) => {
    const wanted = message.params?.notifications;
    if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
      write(rpcError(message.id, -32602, "Invalid params: 'notifications' is required"));
      return;
    }
    const honoured = wanted.toolsListChanged === true ? { toolsListChanged: true } : {};
    listens.set(message.id, honoured);
    write({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: honoured, _meta: { [SUBSCRIPTION_ID]: message.id } },
    });
    if (owedNotice && honoured.toolsListChanged) announceToolsChanged();
    if (!connection(env)) watchForKey();
  };

  /** notifications/cancelled: end that listen, or stop that request and never answer it. */
  const cancel = (message) => {
    const id = message.params?.requestId;
    if (id === undefined || id === null) return;
    if (listens.delete(id)) return;
    const pending = inFlight.get(id);
    if (pending) {
      pending.cancelled = true;
      pending.controller.abort();
    }
  };

  /**
   * The start and the tool list, answered here with no tools and these instructions: while there
   * is no key, or while Aimiru cannot be reached or refuses the key. True when it answered.
   */
  const answerHere = (message, instructions) => {
    if (message.method === 'initialize') {
      protocolVersion = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18';
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'aimiru', version: VERSION },
          instructions,
        },
      });
    } else if (message.method === 'server/discover') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: { tools: { listChanged: true } },
          instructions,
        },
      });
    } else if (message.method === 'ping') {
      write({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    } else {
      return false;
    }
    return true;
  };

  /** What this server answers itself while there is no key. */
  const answerUnconnected = (message) => {
    if (!isRequest(message)) return;
    if (message.method !== 'ping') watchForKey();
    if (answerHere(message, TOOL_SERVER_MESSAGES.instructionsNotConnected)) return;
    write(rpcError(message.id, NOT_CONNECTED, TOOL_SERVER_MESSAGES.notConnected));
  };

  /** The headers a message goes to Aimiru with. */
  const headersFor = (message, conn) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${conn.token}`,
    };
    const era = envelopeVersion(message);
    if (era) {
      headers['mcp-protocol-version'] = era;
      if (message.method) headers['mcp-method'] = message.method;
      if (message.method === 'tools/call' && typeof message.params?.name === 'string') headers['mcp-name'] = message.params.name;
    } else if (protocolVersion && message.method !== 'initialize') {
      headers['mcp-protocol-version'] = protocolVersion;
    }
    return headers;
  };

  /**
   * True when Aimiru answers a tool list with this key: its reply to the probe carries a result. A
   * reply that carries an error (even with HTTP 200) is not Aimiru back, or the tools would be said
   * to change on every try while Claude Code's own list keeps failing.
   */
  const aimiruAnswers = async (conn) => {
    const probe = { jsonrpc: '2.0', id: 'aimiru-probe', method: 'tools/list', params: lastMeta ? { _meta: lastMeta } : {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), startTimeoutMs);
    try {
      const res = await fetchImpl(conn.endpoint, {
        method: 'POST',
        headers: headersFor(probe, conn),
        body: JSON.stringify(probe),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        if (res.status === 401) refusedKey = conn.token;
        return false;
      }
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream') && res.body) {
        for await (const reply of eventStream(res.body)) {
          if (isAnswer(reply, probe.id)) return reply.result !== undefined;
        }
        return false;
      }
      let replies;
      try {
        const parsed = JSON.parse(await res.text());
        replies = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return false; // not an answer
      }
      return replies.some((reply) => isAnswer(reply, probe.id) && reply.result !== undefined);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Aimiru is back: the tools changed (Claude Code lists them again and gets Aimiru's own). */
  const aimiruBack = () => {
    stopRetrying();
    refusedKey = null;
    announceToolsChanged();
  };

  /** Aimiru did not answer the start: try it again in the background until it does. */
  const retryAimiru = () => {
    if (retrier || retryMs <= 0) return;
    retrier = setInterval(async () => {
      if (probing) return;
      const conn = connection(env);
      // No key now (the not connected path takes over), or the key Aimiru refused: nothing to send.
      if (!conn || conn.token === refusedKey) return;
      probing = true;
      try {
        if (retrier && (await aimiruAnswers(conn))) aimiruBack();
      } finally {
        probing = false;
      }
    }, retryMs);
    retrier.unref?.();
  };

  const forward = async (message, conn) => {
    const headers = headersFor(message, conn);
    const request = isRequest(message);
    // The start and the tool list are answered here when Aimiru does not answer them.
    const starting = request && START_METHODS.has(message.method);
    const pending = { controller: new AbortController(), cancelled: false };
    if (request) inFlight.set(message.id, pending);
    const timer = setTimeout(() => pending.controller.abort(), starting ? startTimeoutMs : REQUEST_TIMEOUT_MS);
    let answered = false;
    // Nothing more is written for a request Claude Code cancelled.
    const pass = (reply) => {
      if (pending.cancelled || !reply || typeof reply !== 'object' || reply.jsonrpc !== '2.0') return;
      // An error for the start is not passed on: the start is answered here instead (below).
      if (starting && reply.id === message.id && reply.error !== undefined) return;
      if (message.method === 'initialize' && reply.id === message.id && typeof reply.result?.protocolVersion === 'string') {
        protocolVersion = reply.result.protocolVersion;
      }
      write(reply);
      if (request && isAnswer(reply, message.id)) {
        answered = true;
        if (message.method === 'tools/list') {
          // Claude Code has Aimiru's own list now.
          stopRetrying();
          owedNotice = false;
        } else if (retrier) {
          aimiruBack();
        }
      }
    };
    const fail = (code, text) => {
      if (!request || answered || pending.cancelled) return;
      if (starting) {
        const refused = code === NOT_CONNECTED;
        if (refused) refusedKey = conn.token;
        const said = !refused ? TOOL_SERVER_MESSAGES.instructionsUnreachable : text === TOOL_SERVER_MESSAGES.demoEnded ? text : TOOL_SERVER_MESSAGES.instructionsKeyRefused;
        answerHere(message, said);
        retryAimiru();
        return;
      }
      write(rpcError(message.id, code, text));
    };
    try {
      let res;
      try {
        res = await fetchImpl(conn.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          // Never forward the key to another host, as the hooks' client (vendor/aimiru-client.mjs):
          // a redirect is refused and reads as Aimiru not reached.
          redirect: 'error',
          signal: pending.controller.signal,
        });
      } catch {
        fail(UNREACHABLE, TOOL_SERVER_MESSAGES.unreachable);
        return;
      }
      if (res.status === 401) {
        fail(NOT_CONNECTED, (await demoEndedAnswer(res)) ? TOOL_SERVER_MESSAGES.demoEnded : TOOL_SERVER_MESSAGES.keyRefused);
        return;
      }
      if (starting && res.status >= 500) {
        // Aimiru is down behind its address (a host's error page): the start is answered here.
        res.body?.cancel().catch(() => {});
        fail(UNREACHABLE, TOOL_SERVER_MESSAGES.unreachable);
        return;
      }
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream') && res.body) {
        // Each message as it arrives; once the answer is in, the stream is let go.
        for await (const reply of eventStream(res.body)) {
          pass(reply);
          if (answered || pending.cancelled) break;
        }
      } else {
        const text = await res.text();
        let replies = [];
        if (text.trim()) {
          try {
            const parsed = JSON.parse(text);
            replies = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            replies = [];
          }
        }
        for (const reply of replies) pass(reply);
      }
      fail(UNREACHABLE, TOOL_SERVER_MESSAGES.unreachable);
    } catch {
      // The stream broke, the time ran out or Claude Code cancelled the request.
      fail(UNREACHABLE, TOOL_SERVER_MESSAGES.unreachable);
    } finally {
      clearTimeout(timer);
      if (request && inFlight.get(message.id) === pending) inFlight.delete(message.id);
    }
  };

  const handle = async (line) => {
    if (typeof line !== 'string' || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    // Answers to requests a server never sends here (this one is stateless): nothing to do.
    if (!isRequest(message) && !isNotification(message)) return;
    if (envelopeVersion(message)) {
      modern = true;
      lastMeta = message.params._meta;
    }
    // Between Claude Code and this bridge only: Aimiru keeps nothing between messages.
    if (message.method === 'notifications/cancelled') {
      cancel(message);
      return;
    }
    if (message.method === 'subscriptions/listen' && isRequest(message)) {
      modern = true;
      answerListen(message);
      return;
    }
    const conn = connection(env);
    if (!conn) {
      answerUnconnected(message);
      return;
    }
    stopWatching();
    await forward(message, conn);
  };

  const close = () => {
    stopWatching();
    stopRetrying();
    listens.clear();
    for (const pending of inFlight.values()) {
      pending.cancelled = true;
      pending.controller.abort();
    }
  };

  return { handle, close };
}

const invoked = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  const server = createToolServer({
    write: (m) => process.stdout.write(`${JSON.stringify(m)}\n`),
    watchMs: Number(setting(process.env, 'TOOL_SERVER_WATCH_MS')) || WATCH_MS,
    retryMs: Number(setting(process.env, 'TOOL_SERVER_RETRY_MS')) || RETRY_MS,
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  lines.on('line', (line) => {
    const p = server.handle(line).catch(() => {});
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  });
  lines.on('close', async () => {
    await Promise.allSettled([...inFlight]);
    server.close();
    process.exit(0);
  });
}
