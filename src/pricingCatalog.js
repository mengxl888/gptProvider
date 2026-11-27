import { pricingInfo, validatePrices } from './pricing.js';
import { fetchOfficialPricing } from './pricingSync.js';

export const PRICING_SYNC_INTERVAL_MS = 24 * 3600_000;
const RETRY_INTERVAL_MS = 3600_000;

// Reference prices and administrator overrides are stored separately. A failed
// refresh must never remove a usable catalog or overwrite an administrator's rates.
export class PricingCatalog {
  constructor({ store, fetchPrices = fetchOfficialPricing, now = () => Date.now() }) {
    this.store = store;
    this.fetchPrices = fetchPrices;
    this.now = now;
    this.pending = null;
    this.timer = null;
  }

  info() {
    const settings = this.store.data.settings;
    const reference = settings.pricingReference || {};
    return {
      ...pricingInfo(settings.modelPrices, reference),
      autoSync: settings.pricingAutoSync !== false,
      syncedAt: reference.syncedAt || null,
      syncError: reference.syncError || null,
      syncing: Boolean(this.pending),
      intervalMs: PRICING_SYNC_INTERVAL_MS,
    };
  }

  update(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (!Object.hasOwn(body, 'models') && !Object.hasOwn(body, 'autoSync'))) {
      throw Object.assign(new Error('请提供 models 或 autoSync'), { status: 400, code: 'invalid_pricing' });
    }
    const patch = {};
    if (Object.hasOwn(body, 'models')) patch.modelPrices = validatePrices(body.models);
    if (Object.hasOwn(body, 'autoSync')) {
      if (typeof body.autoSync !== 'boolean') {
        throw Object.assign(new Error('autoSync 必须是布尔值'), { status: 400, code: 'invalid_pricing' });
      }
      patch.pricingAutoSync = body.autoSync;
    }
    this.save(patch);
    return this.info();
  }

  save(patch) {
    const settings = this.store.data.settings;
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, {
      exists: Object.hasOwn(settings, key), value: settings[key],
    }]));
    Object.assign(settings, patch);
    try {
      this.store.save();
    } catch (err) {
      for (const [key, entry] of Object.entries(previous)) {
        if (entry.exists) settings[key] = entry.value;
        else delete settings[key];
      }
      throw err;
    }
  }

  async sync() {
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    await this.pending;
    return this.info();
  }

  async refresh() {
    const lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const next = await this.fetchPrices();
      const previous = this.store.data.settings.pricingReference || {};
      this.save({ pricingReference: {
        ...previous,
        ...next,
        models: { ...previous.models, ...next.models },
        lastAttemptAt,
        syncError: null,
      } });
    } catch (err) {
      this.save({ pricingReference: {
        ...this.store.data.settings.pricingReference,
        lastAttemptAt,
        syncError: String(err.message || '参考价格同步失败').slice(0, 500),
      } });
      throw err;
    }
  }

  async refreshIfDue() {
    const settings = this.store.data.settings;
    if (settings.pricingAutoSync === false) return this.info();
    const reference = settings.pricingReference || {};
    const elapsed = this.now() - Date.parse(reference.syncedAt);
    const sinceAttempt = this.now() - Date.parse(reference.lastAttemptAt);
    if (elapsed >= 0 && elapsed < PRICING_SYNC_INTERVAL_MS) return this.info();
    if (sinceAttempt >= 0 && sinceAttempt < RETRY_INTERVAL_MS) return this.info();
    return this.sync();
  }

  start() {
    if (this.timer) return;
    const refresh = () => this.refreshIfDue().catch((err) => console.warn('[pricing] 参考价格同步失败:', err.message));
    void refresh();
    this.timer = setInterval(refresh, RETRY_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
