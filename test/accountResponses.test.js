import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';

import { AccountManager } from '../src/codex/accounts.js';
import { CodexResponsesProxy, needsNativeResponses } from '../src/codex/responsesProxy.js';
import { MAX_ERROR_BODY_BYTES } from '../src/codex/responseErrors.js';
import { CODEX_DESKTOP_USER_AGENT, normalizeSystemMessages, responsesUserAgent } from '../src/codex/clientCompatibility.js';
import { handleResponses } from '../src/openai/responses.js';
import { withLog } from '../src/requestLog.js';

// All credentials and upstream streams in this suite are synthetic. No CODEX_HOME,
// persisted gateway data, Codex process, or network endpoint is used.
class ResponseSink extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.chunks = [];
    this.headers = {};
    this.headersSent = false;
    this.statusCode = null;
  }

  _write(chunk, encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  get body() { return Buffer.concat(this.chunks); }
  get json() { return JSON.parse(this.body.toString('utf8')); }
}

function request() {
  const req = new EventEmitter();
  req.headers = { authorization: 'Bearer synthetic-downstream-key' };
  req.events = [];
  req.log = Object.fromEntries(['request', 'account', 'resolvedModel', 'usage', 'fail', 'upstreamRequest'].map((name) => [
    name, (value) => req.events.push({ name, value }),
  ]));
  return req;
}

function response(status = 'completed', overrides = {}) {
  return {
    id: 'resp_synthetic', object: 'response', model: 'gpt-6.1-sol', status,
    output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好 🌏' }] }],
    usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
    ...overrides,
  };
}

function event(type, data, newline = '\n') {
  return `event: ${type}${newline}data: ${JSON.stringify({ type, ...data })}${newline}${newline}`;
}

function terminalSse(result = response()) {
  const type = `response.${result.status}`;
  return Buffer.from(event(type, { response: result }));
}

function upstream(bytes = terminalSse(), { chunks, headers = {} } = {}) {
  const pieces = chunks || [bytes];
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream', ...headers } });
}

function harness(fetchImpl = async () => upstream()) {
  const account = { id: 'synthetic-account', label: 'Synthetic', status: 'ready' };
  const authCalls = [];
  const fetchCalls = [];
  const accounts = {
    activeAccount: () => account,
    responsesAuth: async (id, options) => {
      authCalls.push({ id, options });
      return { accessToken: options?.rejectedToken ? 'synthetic-refreshed' : 'synthetic-initial', accountId: 'synthetic-workspace' };
    },
  };
  const proxy = new CodexResponsesProxy({
    accounts, store: { data: { settings: { defaultModel: 'gpt-6.1-sol' } } }, codex: { version: '0.165.0' },
    fetchImpl: async (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  });
  return { proxy, accounts, account, authCalls, fetchCalls };
}

const toolBody = (extra = {}) => ({ model: 'gpt-6.1-sol', input: 'Run the tool', tools: [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} } }], ...extra });

test('non-Codex clients use the exact requested Desktop User-Agent and retain their incoming headers', async () => {
  const expected = 'Codex Desktop/0.165.0-alpha.1.2 (Windows 10.0.22631; x86_64) unknown (Codex Desktop; 26.1023.51421)';
  assert.equal(CODEX_DESKTOP_USER_AGENT, expected);
  for (const original of [undefined, '', 'OpenAI/Python 2.0.0', 'OpenAI/JS 6.0.0', 'python-requests/2.32.0', 'CustomCodexClient/1.0', 'my_codex_cli_rs/1.0', 'OpenAI/Python 2.0 codex-compatible']) {
    const req = request();
    if (original !== undefined) req.headers['user-agent'] = original;
    const originalHeaders = structuredClone(req.headers);
    const h = harness();
    await h.proxy.handle(req, new ResponseSink(), toolBody());
    assert.equal(h.fetchCalls[0][1].headers['user-agent'], expected, String(original));
    assert.deepEqual(req.headers, originalHeaders);
    assert.deepEqual(req.events.find((entry) => entry.name === 'upstreamRequest')?.value, {
      userAgent: expected, userAgentRewritten: true, systemMessagesConverted: 0,
    });
  }
});

test('Codex product User-Agents retain their original complete values case-insensitively', async () => {
  for (const original of [
    CODEX_DESKTOP_USER_AGENT,
    'codex_cli_rs/0.165.0 (Windows 10.0.22631; x86_64) unknown',
    'codex_vscode/0.165.0 (Linux; x86_64)',
    'codex_local_gateway/0.165.0',
    'CODEX_CLI_RS/0.165.0 (Windows; x86_64)',
    'cOdEx DeSkToP/0.165.0-alpha.1.2 custom-build',
    'Codex/0.165.0', 'codex-tui/0.165.0', 'codex_atlas/0.165.0',
  ]) {
    const req = request();
    req.headers['user-agent'] = original;
    const h = harness();
    await h.proxy.handle(req, new ResponseSink(), toolBody());
    assert.equal(h.fetchCalls[0][1].headers['user-agent'], original);
    assert.equal(req.headers['user-agent'], original);
    assert.deepEqual(req.events.find((entry) => entry.name === 'upstreamRequest')?.value, {
      userAgent: original, userAgentRewritten: false, systemMessagesConverted: 0,
    });
    assert.deepEqual(responsesUserAgent(original), { userAgent: original, userAgentRewritten: false });
  }
});

test('native system messages become developer messages without mutating content, tools, typed history or ordering', async () => {
  const req = request();
  req.headers['user-agent'] = 'OpenAI/Python 2.0.0';
  const body = toolBody({
    stream: true,
    instructions: 'Existing top-level instructions',
    reasoning: { effort: 'high' },
    input: [
      { role: 'system', content: 'System one' },
      { role: 'developer', content: [{ type: 'input_text', text: 'Existing developer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Question' }] },
      { type: 'reasoning', id: 'rs_system_test', encrypted_content: 'synthetic-encrypted-reasoning', summary: [] },
      { type: 'function_call', id: 'fc_system_test', call_id: 'call_system_test', name: 'ping', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_system_test', output: 'done' },
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'System two' }] },
      { type: 'custom_tool_call', id: 'ct_system_test', call_id: 'custom_system_test', name: 'apply_patch', input: 'patch' },
      { type: 'custom_tool_call_output', call_id: 'custom_system_test', output: 'applied' },
      { type: 'additional_tools', tools: [{ type: 'function', name: 'second_tool', parameters: { type: 'object', properties: {} } }] },
    ],
  });
  const before = structuredClone(body);
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(body);
  const h = harness(async (url, options) => {
    assert.deepEqual(req.events.find((entry) => entry.name === 'upstreamRequest')?.value, {
      userAgent: options.headers['user-agent'], userAgentRewritten: true, systemMessagesConverted: 2,
    });
    return upstream();
  });
  await h.proxy.handle(req, new ResponseSink(), body);
  const sent = JSON.parse(h.fetchCalls[0][1].body);
  const expectedInput = before.input.map((item, index) => [0, 6].includes(index) ? { ...item, role: 'developer' } : item);
  assert.deepEqual(sent.input, expectedInput);
  assert.deepEqual(sent.tools, before.tools);
  assert.deepEqual(sent.reasoning, before.reasoning);
  assert.equal(sent.instructions, before.instructions);
  assert.equal(sent.input.length, before.input.length);
  assert.equal(sent.input.filter((item) => item.role === 'system').length, 0);
  assert.deepEqual(body, before);
  for (const field of ['userAgent', 'userAgentRewritten', 'systemMessagesConverted']) assert.equal(Object.hasOwn(sent, field), false);
  assert.equal(req.events.filter((entry) => entry.name === 'upstreamRequest').length, 1);
});

test('developer-only input is not duplicated and typed tool items with role-like metadata remain unchanged', async () => {
  const input = [
    { type: 'message', role: 'developer', content: 'Keep this instruction' },
    { role: 'user', content: 'Question' },
    { type: 'function_call_output', role: 'system', call_id: 'synthetic_call', output: 'synthetic role-like metadata' },
  ];
  const normalized = normalizeSystemMessages(input);
  assert.equal(normalized.input, input);
  assert.equal(normalized.systemMessagesConverted, 0);
  const req = request();
  req.headers['user-agent'] = 'codex_vscode/0.165.0';
  const h = harness();
  await h.proxy.handle(req, new ResponseSink(), toolBody({ input }));
  assert.deepEqual(JSON.parse(h.fetchCalls[0][1].body).input, input);
  assert.deepEqual(req.events.find((entry) => entry.name === 'upstreamRequest')?.value, {
    userAgent: 'codex_vscode/0.165.0', userAgentRewritten: false, systemMessagesConverted: 0,
  });
  assert.equal(needsNativeResponses({ input: [{ role: 'system', content: 'Plain conversation' }, { role: 'user', content: 'Hello' }] }), false);
});

test('native routing recognizes tools and typed history while hosted tools retain their path', () => {
  for (const type of ['function', 'custom', 'namespace']) assert.equal(needsNativeResponses(toolBody({ tools: [{ type }] })), true);
  for (const type of ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'compaction']) {
    assert.equal(needsNativeResponses({ input: [{ type }] }), true, type);
  }
  assert.equal(needsNativeResponses({ input: [{ type: 'reasoning', encrypted_content: 'synthetic-ciphertext' }] }), true);
  assert.equal(needsNativeResponses({ include: ['reasoning.encrypted_content'] }), true);
  assert.equal(needsNativeResponses({ input: 'Hello' }), false);
  assert.equal(needsNativeResponses({ input: [{ type: 'reasoning', summary: [] }], tools: [] }), false);
  assert.equal(needsNativeResponses({ tools: [{ type: 'image_generation' }, { type: 'web_search' }, { type: 'web_search_preview' }] }), false);
});

test('explicit Lite header and additional_tools select native routing without inferring from model', async () => {
  const lite = 'x-openai-internal-codex-responses-lite';
  assert.equal(needsNativeResponses({ model: 'gpt-5.6-sol', input: 'Hello' }), false);
  assert.equal(needsNativeResponses({ input: 'Hello' }, { [lite]: 'false' }), false);
  assert.equal(needsNativeResponses({ input: 'Hello' }, { [lite]: 'true' }), true);
  assert.equal(needsNativeResponses({ input: [{ type: 'additional_tools', tools: [{ type: 'function', name: 'ping' }] }] }), true);
  const h = harness();
  const req = request();
  req.headers[lite] = 'true';
  const body = { model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'Hello' }], stream: true };
  const res = new ResponseSink();
  await handleResponses(req, res, body, { accountResponses: h.proxy });
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0][1].headers[lite], 'true');
  assert.deepEqual(JSON.parse(h.fetchCalls[0][1].body).input, body.input);
  assert.equal(JSON.parse(h.fetchCalls[0][1].body).model, 'gpt-5.6-sol');
});

test('Lite request header is passed through verbatim only when present', async () => {
  const lite = 'x-openai-internal-codex-responses-lite';
  for (const value of [undefined, 'true', 'false']) {
    const h = harness();
    const req = request();
    if (value !== undefined) req.headers[lite] = value;
    await h.proxy.handle(req, new ResponseSink(), toolBody());
    assert.equal(h.fetchCalls[0][1].headers[lite], value);
    assert.equal(Object.hasOwn(h.fetchCalls[0][1].headers, lite), value !== undefined);
  }
});

async function capturedError(fetchImpl, { body = toolBody(), req = request() } = {}) {
  const h = harness(fetchImpl);
  const res = new ResponseSink();
  let error;
  await assert.rejects(withLog(req, res, { ...req.log, end() {} }, () => h.proxy.handle(req, res, body)), (err) => {
    error = err;
    return true;
  });
  return { ...h, req, res, error };
}

for (const [label, payload, expected] of [
  ['error object', { error: { message: 'Unsupported reasoning effort', code: 'unsupported_parameter', type: 'invalid_request_error', param: 'reasoning.effort' } }, { message: 'Unsupported reasoning effort', code: 'unsupported_parameter', type: 'invalid_request_error', param: 'reasoning.effort' }],
  ['error string', { error: 'Instructions are required', code: 'missing_instructions', param: 'instructions' }, { message: 'Instructions are required', code: 'missing_instructions', param: 'instructions' }],
  ['detail string', { detail: 'Missing required field: instructions' }, { message: 'Missing required field: instructions', code: 'upstream_error' }],
  ['diagnostic prose after input', { detail: 'Invalid input: reasoning.effort ultra is unsupported' }, { message: 'Invalid input: reasoning.effort ultra is unsupported', code: 'upstream_error' }],
  ['detail object', { detail: { message: 'Expected an array', code: 'invalid_input', type: 'invalid_request_error', param: 'input' } }, { message: 'Expected an array', code: 'invalid_input', type: 'invalid_request_error', param: 'input' }],
  ['nested detail error', { detail: { error: { message: 'Unknown tool name', code: 'invalid_tool', param: 'tools[0].name' } } }, { message: 'Unknown tool name', code: 'invalid_tool', param: 'tools[0].name' }],
  ['top-level message', { message: 'This model requires a developer message', code: 'missing_message' }, { message: 'This model requires a developer message', code: 'missing_message' }],
  ['JSON string', 'Unsupported field: service_tier', { message: 'Unsupported field: service_tier', code: 'upstream_error' }],
]) {
  test(`HTTP error diagnostics retain ${label}, safe request id, and the exact field cause in logs`, async () => {
    const { error, req, res, fetchCalls } = await capturedError(async () => new Response(JSON.stringify(payload), { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic_error', 'set-cookie': 'PRIVATE_COOKIE', 'openai-organization': 'PRIVATE_ORG' } }));
    assert.equal(error.status, 400);
    assert.ok(error.message.includes(expected.message));
    assert.equal(error.code, expected.code);
    assert.equal(error.type, expected.type);
    assert.equal(error.param, expected.param);
    if (expected.param) assert.ok(error.message.includes(expected.param));
    assert.equal(error.details.upstreamStatus, 400);
    assert.equal(error.details.requestId, 'req_synthetic_error');
    assert.match(error.message, /req_synthetic_error/);
    assert.equal(res.headers['x-request-id'], 'req_synthetic_error');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['openai-organization'], undefined);
    assert.equal(req.events.find((entry) => entry.name === 'fail').value, error);
    assert.equal(fetchCalls.length, 1);
  });
}

test('FastAPI validation errors retain bounded field paths/messages/types and omit echoed input and context', async () => {
  const detail = Array.from({ length: 12 }, (_, index) => ({
    type: 'missing', loc: ['body', 'input', index, 'call_id'], msg: 'Field required',
    input: { content: 'PRIVATE_VALIDATION_INPUT', headers: { authorization: 'PRIVATE_VALIDATION_HEADER' } },
    ctx: { value: 'PRIVATE_VALIDATION_CONTEXT' },
  }));
  const { error } = await capturedError(async () => new Response(JSON.stringify({ detail }), { status: 400 }));
  assert.match(error.message, /input\[0\]\.call_id: Field required/);
  assert.equal(error.details.validation.length, 8);
  assert.deepEqual(error.details.validation[0], { param: 'input[0].call_id', message: 'Field required', type: 'missing' });
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /PRIVATE_VALIDATION/);
});

test('a validation error for the top-level input field retains its actual reason', async () => {
  const { error } = await capturedError(async () => new Response(JSON.stringify({ detail: [{ type: 'missing', loc: ['body', 'input'], msg: 'Field required', input: { secret: 'PRIVATE_VALIDATION_INPUT' } }] }), { status: 400 }));
  assert.equal(error.param, 'input');
  assert.equal(error.message, 'input: Field required');
});

test('plain-text and SSE HTTP error bodies retain their explicit cause', async () => {
  for (const [content, type, expectedCode, expectedMessage] of [
    ['Unsupported field: instructions', 'text/plain', 'upstream_error', 'Unsupported field: instructions'],
    [event('error', { error: { message: 'Invalid namespace definition', code: 'bad_namespace', param: 'tools[0]' } }), 'text/event-stream', 'bad_namespace', 'Invalid namespace definition'],
  ]) {
    const { error } = await capturedError(async () => new Response(content, { status: 400, headers: { 'content-type': type } }));
    assert.ok(error.message.includes(expectedMessage));
    assert.equal(error.code, expectedCode);
  }
});

test('HTML, empty, malformed JSON and unknown object bodies use an accurate generic fallback', async () => {
  for (const [content, type] of [
    ['<html><body>PRIVATE_LOGIN_PAGE</body></html>', 'text/html'],
    ['<html><body>PRIVATE_LOGIN_PAGE</body></html>', 'text/plain'],
    ['', 'application/json'],
    ['{"input":"PRIVATE_BROKEN_JSON', 'application/json'],
    [JSON.stringify({ input: 'PRIVATE_UNKNOWN_OBJECT', headers: { authorization: 'PRIVATE_UNKNOWN_HEADER' } }), 'application/json'],
  ]) {
    const { error } = await capturedError(async () => new Response(content, { status: 400, headers: { 'content-type': type } }));
    assert.equal(error.message, 'Codex Responses 上游返回 HTTP 400');
    assert.equal(error.code, 'upstream_error');
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /PRIVATE_/);
  }
});

test('diagnostics redact upstream/downstream credentials, arbitrary Bearer/JWT tokens, and echoed input/headers', async () => {
  const foreignJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"sub":"synthetic"}').toString('base64url')}.synthetic-signature`;
  const unusualJwt = `${Buffer.from('{\n "alg": "HS256"\n}').toString('base64url')}.${Buffer.from('{"sub":"synthetic"}').toString('base64url')}.synthetic-signature`;
  const reason = `Invalid tool schema; upstream=synthetic-initial; downstream=synthetic-downstream-key; another=Bearer foreign-secret-value; jwt=${foreignJwt}; unusualJwt=${unusualJwt}; authToken=PRIVATE_OPAQUE_CAMEL; auth_token="PRIVATE_OPAQUE_SNAKE"; input={"text":"PRIVATE_INPUT","nested":[{"x":1}]}; headers={"cookie":"PRIVATE_HEADERS"}; expected a name`;
  const { error, req, res } = await capturedError(async () => new Response(JSON.stringify({ error: { message: reason, code: 'bad_tool_schema', type: 'invalid_request_error', param: 'tools[0]' } }), { status: 400 }));
  const exposed = JSON.stringify({ message: error.message, details: error.details, headers: res.headers, logs: req.events });
  assert.match(error.message, /Invalid tool schema/);
  assert.match(error.message, /expected a name/);
  for (const privateValue of ['synthetic-initial', 'synthetic-downstream-key', 'foreign-secret-value', foreignJwt, unusualJwt, 'PRIVATE_OPAQUE_CAMEL', 'PRIVATE_OPAQUE_SNAKE', 'PRIVATE_INPUT', 'PRIVATE_HEADERS']) assert.ok(!exposed.includes(privateValue), privateValue);
  assert.match(error.message, /REDACTED/);
});

test('error body reads are capped and cancel the remaining upstream stream', async () => {
  let cancelled = false;
  let pulls = 0;
  const { error, fetchCalls } = await capturedError(async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(Buffer.from(`{"detail":"${'x'.repeat(MAX_ERROR_BODY_BYTES + 1024)}`)); },
    cancel() { cancelled = true; },
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  assert.equal(error.message, 'Codex Responses 上游返回 HTTP 400');
  assert.equal(error.details.bodyTruncated, true);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 2);
  assert.equal(fetchCalls.length, 1);
});

test('actual handleResponses routes native tools without losing grammar, namespaces, typed results or reasoning', async () => {
  const h = harness();
  const body = toolBody({
    stream: true, store: true,
    tools: [
      { type: 'function', name: 'ping', strict: true, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
      { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' } },
      { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'run', parameters: { type: 'object', properties: {} } }] },
    ],
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '保留工具协议' }] },
      { type: 'reasoning', id: 'rs_synthetic', encrypted_content: 'synthetic-ciphertext', summary: [] },
      { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'ping', arguments: '{"text":"你好"}' },
      { type: 'function_call_output', call_id: 'call_synthetic', output: [{ type: 'input_text', text: '工具结果' }, { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj' }] },
      { type: 'custom_tool_call', id: 'ct_synthetic', call_id: 'custom_synthetic', name: 'apply_patch', input: 'patch' },
      { type: 'custom_tool_call_output', call_id: 'custom_synthetic', output: 'done' },
    ],
    include: ['reasoning.encrypted_content'], reasoning: { effort: 'high', summary: 'auto' },
  });
  const req = request();
  const res = new ResponseSink();
  await handleResponses(req, res, body, { accountResponses: h.proxy });
  assert.equal(h.fetchCalls.length, 1);
  const [url, options] = h.fetchCalls[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { ...body, store: false, tool_choice: 'auto', parallel_tool_calls: true });
  assert.equal(options.headers.authorization, 'Bearer synthetic-initial');
  assert.equal(options.headers['chatgpt-account-id'], 'synthetic-workspace');
  assert.ok(!Object.values(options.headers).includes('Bearer synthetic-downstream-key'));
  assert.deepEqual(res.body, terminalSse());
});

test('explicit tool choice and parallel-tool settings remain intact', async () => {
  const h = harness();
  const body = toolBody({ tool_choice: { type: 'function', name: 'ping' }, parallel_tool_calls: false });
  await h.proxy.handle(request(), new ResponseSink(), body);
  const sent = JSON.parse(h.fetchCalls[0][1].body);
  assert.deepEqual(sent.tool_choice, body.tool_choice);
  assert.equal(sent.parallel_tool_calls, false);
});

test('tool call SSE, custom input, and encrypted reasoning output pass through intact', async () => {
  const items = [
    { type: 'reasoning', id: 'rs_output', encrypted_content: 'synthetic-encrypted-output', summary: [] },
    { type: 'function_call', id: 'fc_output', call_id: 'call_output', name: 'ping', arguments: '{"text":"你好"}', status: 'completed' },
    { type: 'custom_tool_call', id: 'ct_output', call_id: 'custom_output', name: 'apply_patch', input: 'patch', status: 'completed' },
  ];
  const result = response('completed', { output: items });
  const bytes = Buffer.from([
    event('response.output_item.added', { output_index: 1, item: { ...items[1], status: 'in_progress', arguments: '' } }),
    event('response.function_call_arguments.delta', { output_index: 1, item_id: 'fc_output', delta: '{"text":"你好"}' }),
    event('response.function_call_arguments.done', { output_index: 1, item_id: 'fc_output', arguments: items[1].arguments }),
    event('response.output_item.done', { output_index: 1, item: items[1] }),
    event('response.custom_tool_call_input.delta', { output_index: 2, item_id: 'ct_output', delta: 'patch' }),
    event('response.output_item.done', { output_index: 2, item: items[2] }),
    event('response.completed', { response: result }),
  ].join(''));
  const h = harness(async () => upstream(bytes));
  const streaming = new ResponseSink();
  await h.proxy.handle(request(), streaming, toolBody({ stream: true }));
  assert.deepEqual(streaming.body, bytes);
  const nonstreaming = new ResponseSink();
  await h.proxy.handle(request(), nonstreaming, toolBody());
  assert.deepEqual(nonstreaming.json.output, items);
});

test('minimal terminal Responses metadata is merged with response.created and completed output items', async () => {
  const created = {
    id: 'resp_minimal', object: 'response', created_at: 1234567890,
    model: 'gpt-6.1-sol', status: 'in_progress', output: [],
    instructions: 'Synthetic instruction', tools: [{ type: 'custom', name: 'apply_patch' }],
    reasoning: { effort: 'high', summary: 'auto' },
  };
  const items = [
    { type: 'reasoning', id: 'rs_minimal', encrypted_content: 'synthetic-opaque-reasoning', summary: [] },
    { type: 'function_call', id: 'fc_minimal', call_id: 'call_minimal', name: 'ping', arguments: '{"value":1}', status: 'completed' },
  ];
  const usage = { input_tokens: 7, output_tokens: 4 };
  const bytes = Buffer.from([
    event('response.created', { response: created }),
    ...items.map((item, output_index) => event('response.output_item.done', { output_index, item })),
    event('response.completed', { response: { id: created.id, usage } }),
  ].join(''));
  const h = harness(async () => upstream(bytes));
  const req = request();
  const res = new ResponseSink();
  await h.proxy.handle(req, res, toolBody());
  assert.deepEqual(res.json, { ...created, status: 'completed', output: items, usage });
  assert.equal(req.events.find((e) => e.name === 'resolvedModel')?.value, 'gpt-6.1-sol');
  assert.deepEqual(req.events.find((e) => e.name === 'usage')?.value, { inputTokens: 7, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 });
});

for (const stream of [false, true]) {
  test(`a terminal event completes and cancels an upstream that keeps the connection open (stream=${stream})`, async () => {
    const bytes = terminalSse();
    let cancelled = false;
    let controller;
    const h = harness(async () => new Response(new ReadableStream({
      start(value) { controller = value; controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const res = new ResponseSink();
    let timeout;
    try {
      await Promise.race([
        h.proxy.handle(request(), res, toolBody({ stream })),
        new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Proxy did not stop reading after the terminal event')), 1500); }),
      ]);
      assert.equal(cancelled, true);
      if (stream) assert.deepEqual(res.body, bytes);
      else assert.equal(res.json.status, 'completed');
    } finally {
      clearTimeout(timeout);
      if (!cancelled) controller.close();
    }
  });
}

test('stream preserves every byte across CRLF, multi-data JSON, and split UTF-8 codepoints', async () => {
  const result = response();
  const json = JSON.stringify({ type: 'response.completed', response: result }, null, 2);
  const multiData = json.split('\n').map((line) => `data: ${line}`).join('\r\n');
  const bytes = Buffer.from(`: 心跳\r\n\r\nevent: response.output_text.delta\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好 🌏' })}\r\n\r\nevent: response.completed\r\n${multiData}\r\n\r\n`);
  const h = harness(async () => upstream(bytes, { chunks: Array.from(bytes, (byte) => Uint8Array.of(byte)) }));
  const req = request();
  const res = new ResponseSink();
  await h.proxy.handle(req, res, toolBody({ stream: true }));
  assert.deepEqual(res.body, bytes);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.events.find((e) => e.name === 'usage')?.value, { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: 2 });
  assert.equal(req.events.filter((e) => e.name === 'fail').length, 0);
});

for (const status of ['completed', 'failed', 'incomplete']) {
  test(`nonstream ${status} aggregates the terminal response with its usage and status`, async () => {
    const result = response(status, status === 'failed' ? { error: { code: 'synthetic_failure', message: 'Synthetic failure' } } : status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {});
    const h = harness(async () => upstream(terminalSse(result)));
    const req = request();
    const res = new ResponseSink();
    await h.proxy.handle(req, res, toolBody());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, result);
    assert.equal(req.events.filter((e) => e.name === 'usage').length, 1);
    const failures = req.events.filter((e) => e.name === 'fail');
    assert.equal(failures.length, status === 'failed' ? 1 : 0);
    if (failures.length) assert.equal(failures[0].value.code, 'synthetic_failure');
  });
}

for (const stream of [false, true]) {
  test(`a valid SSE response without Content-Type is accepted (stream=${stream})`, async () => {
    const bytes = terminalSse();
    const h = harness(async () => {
      const value = new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }));
      assert.equal(value.headers.get('content-type'), null);
      return value;
    });
    const req = request();
    const res = new ResponseSink();
    await h.proxy.handle(req, res, toolBody({ stream }));
    assert.equal(res.statusCode, 200);
    if (stream) {
      assert.deepEqual(res.body, bytes);
      assert.match(res.headers['content-type'], /text\/event-stream/);
    } else {
      assert.deepEqual(res.json, response());
      assert.match(res.headers['content-type'], /application\/json/);
    }
    assert.equal(req.events.filter((entry) => entry.name === 'fail').length, 0);
    assert.equal(h.fetchCalls.length, 1);
  });

  test(`explicit HTML Content-Type is rejected before downstream output (stream=${stream})`, async () => {
    let cancelled = false;
    const h = harness(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('<html>Synthetic login page</html>')); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const res = new ResponseSink();
    await assert.rejects(h.proxy.handle(request(), res, toolBody({ stream })), { status: 502, code: 'invalid_upstream_response' });
    assert.equal(cancelled, true);
    assert.equal(res.headersSent, false);
    assert.equal(res.body.length, 0);
    assert.equal(h.fetchCalls.length, 1);
  });

  test(`safe upstream response headers are preserved and credentials excluded (stream=${stream})`, async () => {
    const h = harness(async () => upstream(terminalSse(), { headers: { 'x-request-id': 'req_synthetic', 'x-codex-turn-state': 'synthetic-turn-state', 'set-cookie': 'secret=synthetic', 'openai-organization': 'synthetic-private-org' } }));
    const res = new ResponseSink();
    await h.proxy.handle(request(), res, toolBody({ stream }));
    assert.equal(res.headers['x-request-id'], 'req_synthetic');
    assert.equal(res.headers['x-codex-turn-state'], 'synthetic-turn-state');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['openai-organization'], undefined);
  });
}

test('truncated nonstream fails instead of reporting a successful completion', async () => {
  const h = harness(async () => upstream(Buffer.from(event('response.created', { response: response('in_progress') }))));
  const res = new ResponseSink();
  await assert.rejects(h.proxy.handle(request(), res, toolBody()), { status: 502, code: 'upstream_disconnected' });
  assert.equal(res.headersSent, false);
});

test('truncated stream logs the failure and terminates with an explicit error event', async () => {
  const original = Buffer.from(event('response.created', { response: response('in_progress') }));
  const h = harness(async () => upstream(original));
  const req = request();
  const res = new ResponseSink();
  await h.proxy.handle(req, res, toolBody({ stream: true }));
  assert.deepEqual(res.body.subarray(0, original.length), original);
  assert.match(res.body.toString('utf8'), /event: error/);
  assert.match(res.body.toString('utf8'), /upstream_disconnected/);
  assert.equal(req.events.find((e) => e.name === 'fail')?.value.code, 'upstream_disconnected');
  assert.equal(h.fetchCalls.length, 1);
});

test('401 refreshes once before output and retries the originally selected account', async () => {
  let attempts = 0;
  const h = harness(async () => ++attempts === 1 ? new Response('{"error":{"message":"Expired synthetic token"}}', { status: 401 }) : upstream());
  let selections = 0;
  h.accounts.activeAccount = () => { selections++; return selections === 1 ? h.account : { id: 'other-account' }; };
  const res = new ResponseSink();
  await h.proxy.handle(request(), res, toolBody({ stream: true }));
  assert.equal(selections, 1);
  assert.deepEqual(h.authCalls, [{ id: 'synthetic-account', options: undefined }, { id: 'synthetic-account', options: { rejectedToken: 'synthetic-initial' } }]);
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.fetchCalls[1][1].headers.authorization, 'Bearer synthetic-refreshed');
  assert.deepEqual(res.body, terminalSse());
});

test('a second 401 stops after one refresh and returns an account error', async () => {
  const h = harness(async () => new Response('{"error":{"message":"Still unauthorized"}}', { status: 401 }));
  const res = new ResponseSink();
  await assert.rejects(h.proxy.handle(request(), res, toolBody({ stream: true })), { status: 503, code: 'account_auth_failed' });
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.authCalls.length, 2);
  assert.equal(res.headersSent, false);
});

test('non-401 upstream failures do not retry and retain retry-after', async () => {
  const h = harness(async () => new Response('{"error":{"message":"Synthetic rate limit","code":"rate_limit_exceeded"}}', { status: 429, headers: { 'retry-after': '17' } }));
  const res = new ResponseSink();
  await assert.rejects(h.proxy.handle(request(), res, toolBody()), { status: 429, code: 'rate_limit_exceeded' });
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.authCalls.length, 1);
  assert.equal(res.headers['retry-after'], '17');
});

test('downstream cancellation aborts the upstream signal and stops the request', async () => {
  let sent;
  const started = new Promise((resolve) => { sent = resolve; });
  let observedSignal;
  const h = harness(async (url, { signal }) => {
    observedSignal = signal;
    sent();
    return new Response(new ReadableStream({
      start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const res = new ResponseSink();
  const pending = h.proxy.handle(request(), res, toolBody({ stream: true }));
  await started;
  res.destroy();
  await assert.rejects(pending, { aborted: true, status: 499 });
  assert.equal(observedSignal.aborted, true);
  assert.equal(h.fetchCalls.length, 1);
});

for (const stream of [false, true]) {
  test(`max_output_tokens is accepted without forwarding an unsupported cap (stream=${stream})`, async () => {
    const h = harness();
    const req = request();
    const res = new ResponseSink();
    const input = [{ role: 'user', content: 'Call ping' }, { type: 'function_call_output', call_id: 'earlier', output: 'a tool result' }];
    const body = toolBody({ stream, max_output_tokens: 8192, input });
    await handleResponses(req, res, body, { accountResponses: h.proxy });
    assert.equal(h.fetchCalls.length, 1);
    const payload = JSON.parse(h.fetchCalls[0][1].body);
    assert.equal(Object.hasOwn(payload, 'max_output_tokens'), false);
    assert.deepEqual(payload.input, input);
    assert.deepEqual(payload.tools, body.tools);
    assert.equal(res.headers['x-gptprovider-ignored-parameters'], 'max_output_tokens');
    assert.equal(res.headers['access-control-expose-headers'], 'x-gptprovider-ignored-parameters');
    assert.equal(req.events.some((entry) => entry.name === 'fail'), false);
    if (stream) assert.deepEqual(res.body, terminalSse());
    else assert.equal(res.json.status, 'completed');
  });
}

test('missing or null output token limits do not advertise an ignored parameter', async () => {
  for (const extra of [{}, { max_output_tokens: null }]) {
    const h = harness();
    const res = new ResponseSink();
    await h.proxy.handle(request(), res, toolBody(extra));
    assert.equal(Object.hasOwn(JSON.parse(h.fetchCalls[0][1].body), 'max_output_tokens'), false);
    assert.equal(res.headers['x-gptprovider-ignored-parameters'], undefined);
  }
});

test('invalid output token limits fail without contacting the account and retain request metadata', async () => {
  const h = harness();
  for (const limit of [0, -1, 1.5, '8192', Number.MAX_SAFE_INTEGER + 1]) {
    const req = request();
    await assert.rejects(h.proxy.handle(req, new ResponseSink(), toolBody({ max_output_tokens: limit })), { status: 400, code: 'invalid_parameter' });
    assert.ok(req.events.some((entry) => entry.name === 'request' && entry.value.model === 'gpt-6.1-sol'));
  }
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.authCalls.length, 0);
});

test('previous_response_id and unsupported parameters fail before obtaining credentials or fetching', async () => {
  const h = harness();
  for (const extra of [{ previous_response_id: 'resp_synthetic' }, { temperature: 0 }, { background: true }]) {
    await assert.rejects(h.proxy.handle(request(), new ResponseSink(), toolBody(extra)), { status: 400, code: 'unsupported_parameter' });
  }
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.authCalls.length, 0);
});

test('ordinary hosted tools keep the app-server runTurn route', async () => {
  let threadHandler;
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread_synthetic' }, model: 'gpt-6.1-sol' };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          threadHandler('item/started', { item: { id: 'msg_synthetic', type: 'agentMessage', phase: 'final_answer' } });
          threadHandler('item/agentMessage/delta', { itemId: 'msg_synthetic', delta: 'Hosted hello' });
          threadHandler('item/completed', { item: { id: 'msg_synthetic', type: 'agentMessage', phase: 'final_answer', text: 'Hosted hello' } });
          threadHandler('turn/completed', { turn: { status: 'completed' } });
        });
        return { turn: { id: 'turn_synthetic' } };
      }
      return {};
    },
    subscribeThread(id, callback) { threadHandler = callback; return () => {}; },
  };
  const ctx = {
    accountResponses: { handle() { assert.fail('Hosted requests must not use native tool proxy'); } },
    accounts: { activeClient: async () => ({ account: { id: 'synthetic-account' }, client }), supportsImageGeneration: () => true, generatedImagesDir: () => '/synthetic' },
    store: { data: { settings: { defaultModel: 'gpt-6.1-sol' } } }, images: { save() { assert.fail('No generated image was supplied'); } },
  };
  const res = new ResponseSink();
  await handleResponses(request(), res, { input: 'Hello', store: false, tools: [{ type: 'image_generation' }, { type: 'web_search' }] }, ctx);
  assert.equal(res.json.status, 'completed');
  assert.equal(res.json.output[0].content[0].text, 'Hosted hello');
  const started = calls.find((call) => call.method === 'thread/start');
  assert.equal(started.params.config['features.image_generation'], true);
  assert.equal(started.params.config.web_search, 'live');
});

function jwt(auth = { chatgpt_account_id: 'synthetic-workspace' }, suffix = '') {
  return `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': auth, synthetic: suffix })).toString('base64url')}.synthetic-signature`;
}

function authManager(onRequest) {
  const manager = Object.create(AccountManager.prototype);
  manager.responsesAuthRefreshes = new Map();
  manager.getClient = async (id) => ({ request: async (method, params) => onRequest({ id, method, params }) });
  return manager;
}

test('responsesAuth obtains short-lived credentials from getAuthStatus without reading files', async () => {
  const token = jwt();
  const calls = [];
  const manager = authManager((call) => { calls.push(call); return { authMethod: 'chatgpt', authToken: token }; });
  assert.deepEqual(await manager.responsesAuth('synthetic-account'), { accessToken: token, accountId: 'synthetic-workspace' });
  assert.deepEqual(calls, [{ id: 'synthetic-account', method: 'getAuthStatus', params: { includeToken: true, refreshToken: false } }]);
});

test('responsesAuth merges concurrent refreshes and clears the per-account in-flight entry', async () => {
  const oldToken = jwt(undefined, 'old');
  const newToken = jwt(undefined, 'new');
  let release;
  let refreshing;
  const entered = new Promise((resolve) => { refreshing = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let refreshCount = 0;
  const manager = authManager(async ({ params }) => {
    if (params.refreshToken) { refreshCount++; refreshing(); await gate; return { authMethod: 'chatgpt', authToken: newToken }; }
    return { authMethod: 'chatgpt', authToken: oldToken };
  });
  const pending = Array.from({ length: 3 }, () => manager.responsesAuth('synthetic-account', { rejectedToken: oldToken }));
  await entered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 1);
  release();
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.accessToken === newToken));
  assert.equal(manager.responsesAuthRefreshes.size, 0);
});

test('responsesAuth reuses an already rotated credential without refreshing again', async () => {
  const current = jwt(undefined, 'new');
  const manager = authManager(({ params }) => {
    assert.equal(params.refreshToken, false);
    return { authMethod: 'chatgpt', authToken: current };
  });
  assert.equal((await manager.responsesAuth('synthetic-account', { rejectedToken: jwt(undefined, 'old') })).accessToken, current);
});

for (const [label, result, code] of [
  ['non-chatgpt auth', { authMethod: 'apikey', authToken: jwt() }, 'responses_auth_unavailable'],
  ['missing token', { authMethod: 'chatgpt', authToken: null }, 'responses_auth_unavailable'],
  ['malformed token', { authMethod: 'chatgpt', authToken: 'synthetic-malformed' }, 'responses_auth_unavailable'],
  ['missing account', { authMethod: 'chatgpt', authToken: jwt({}) }, 'responses_auth_unavailable'],
  ['government workspace', { authMethod: 'chatgpt', authToken: jwt({ chatgpt_account_id: 'synthetic-workspace', chatgpt_account_is_fedramp: true }) }, 'unsupported_account'],
]) {
  test(`responsesAuth rejects ${label}`, async () => {
    const manager = authManager(() => result);
    await assert.rejects(manager.responsesAuth('synthetic-account'), { code });
  });
}
