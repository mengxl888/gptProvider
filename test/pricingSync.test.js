import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOfficialPricing, parseOfficialPricing, PRICING_DOWNLOAD_URL } from '../src/pricingSync.js';

// Representative excerpts of the official .md page: columns differ from the
// editor's order, and the cache-write price is not an output or cached rate.
const source = `# Pricing
Prices per 1M tokens.
### Standard pricing data
| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.2-astra | $8.00 | $40.00 | $0.40 | $10.00 | $20.00 | $16.00 | $60.00 | $0.80 | $20.00 | $40.00 |
| gpt-6.2-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5-mini | $0.25 | $2.00 | $0.025 |
| unavailable-cache | $21.00 | $168.00 | - |
| zero-model | $0 | $0 | $0 |

### Batch pricing data
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.2-astra | $4 | $20 | $0.20 |
| batch-only-model | $1 | $2 | $0.10 |

### Fast pricing data
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.2-astra | $16 | $80 | $0.80 |
| gpt-6.2-sol | $4 | $20 | $0.20 |
| gpt-5-mini | $0.45 | $3.60 | $0.045 |

### Ultrafast pricing data
Short context: ≤272K input tokens. Long context: >272K input tokens.
`;

test('official prices use explicit standard columns, complete rows and exact model ids', () => {
  const models = parseOfficialPricing(source);
  assert.deepEqual(models['gpt-6.2-astra'], {
    input: 8, cachedInput: 0.4, output: 40, fastMultiplier: 2,
    longContext: { threshold: 272_000, input: 2, cachedInput: 2, output: 1.5 },
  });
  assert.equal(models['gpt-6.2-sol'].input, 2);
  assert.equal(models['gpt-5.5'].input, 5);
  assert.equal(models['gpt-5-mini'].fastMultiplier, 1.8);
  assert.deepEqual(models['zero-model'], { input: 0, cachedInput: 0, output: 0 });
  assert.equal(models['unavailable-cache'], undefined);
  assert.equal(models['batch-only-model'], undefined);
});

test('malformed pages, missing units, negative prices and truncated tables fail closed', () => {
  for (const invalid of [
    '<html>Checking your browser</html>',
    source.replace('Prices per 1M tokens.', 'Prices per 1K tokens.'),
    source.replace('### Standard pricing data', '### Priority pricing data'),
    source.replace('$8.00', '-8.00'),
    source.replace('$8.00 | $40.00', '$8.00'),
    source.replace('Short context: ≤272K input tokens. Long context: >272K input tokens.', ''),
    source.replace('gpt-6.2-astra | $8.00', '__proto__ | $8.00'),
    source.replace('gpt-6.2-sol | $2.00', 'gpt-6.2-astra | $2.00'),
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseOfficialPricing(invalid), { code: 'pricing_sync_failed', status: 502 });
});

test('price download reads the official Markdown endpoint and returns a timestamped catalog', async () => {
  let requested;
  const result = await fetchOfficialPricing({
    fetchImpl: async (url, options) => { requested = { url, options }; return new Response(source); },
    now: () => new Date('2026-11-27T08:00:00Z'),
  });
  assert.equal(requested.url, PRICING_DOWNLOAD_URL);
  assert.equal(requested.options.signal instanceof AbortSignal, true);
  assert.equal(result.sourceUrl, 'https://developers.openai.com/api/docs/pricing');
  assert.equal(result.syncedAt, '2026-11-27T08:00:00.000Z');
  assert.equal(result.models['gpt-6.2-astra'].output, 40);
});

test('download errors, oversized responses and redirects are rejected without returning a catalog', async () => {
  const redirect = new Response(source);
  Object.defineProperty(redirect, 'url', { value: 'https://example.com/pricing' });
  const cases = [
    async () => { throw new Error('connection refused'); },
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => redirect,
    async () => new Response('<html>Sign in</html>'),
  ];
  for (const fetchImpl of cases) await assert.rejects(fetchOfficialPricing({ fetchImpl }), { status: 502, code: 'pricing_sync_failed' });
});

test('a hung fetch is bounded by a deadline and aborts the request', async () => {
  let signal;
  const pending = fetchOfficialPricing({ timeoutMs: 10, fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(pending, { status: 504, code: 'pricing_sync_failed' });
  assert.equal(signal.aborted, true);
});
