/**
 * Store price rule helpers.
 *
 * Markup: store_price = cost × (1 + percent / 100)
 * e.g. 40 → ×1.40.
 *
 * Effective percent resolution (done by callers / getStorePricingContext):
 *   1. stores.price_rule_percent if set (store override)
 *   2. else app_settings.default_price_rule_percent (super-admin default)
 *   3. else null → sell = cost
 */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * @param {number|string|null|undefined} cost
 * @param {number|string|null|undefined} percent
 * @returns {number|null}
 */
export function applyPriceRule(cost, percent) {
  const c = toNumber(cost)
  if (c === null) return null

  const pct = toNumber(percent)
  if (pct === null) return c

  return round2(c * (1 + pct / 100))
}

/**
 * Cost is Ralawise/CSV: regular_price ?? price.
 *
 * @param {{ regular_price?: any, price?: any }} row
 * @returns {number|null}
 */
export function resolveCostPrice(row) {
  const regular = toNumber(row?.regular_price)
  if (regular !== null) return regular
  return toNumber(row?.price)
}

/**
 * Prefer store override, else default percent.
 *
 * @param {{ price_rule_percent?: any }|null|undefined} store
 * @param {number|string|null|undefined} defaultPercent
 * @returns {number|null}
 */
export function resolveEffectivePercent(store, defaultPercent = null) {
  const override = toNumber(store?.price_rule_percent)
  if (override !== null) return override
  return toNumber(defaultPercent)
}

/**
 * Store sell price using effective markup on cost.
 *
 * Pass either:
 *   - store with price_rule_percent already set to the effective %, or
 *   - store + defaultPercent so override → default is resolved here.
 *
 * @param {{ regular_price?: any, price?: any }} row
 * @param {{ price_rule_percent?: any }|null|undefined} store
 * @param {number|string|null|undefined} [defaultPercent]
 * @returns {number|null}
 */
export function resolveStorePrice(row, store, defaultPercent = null) {
  const cost = resolveCostPrice(row)
  const percent = resolveEffectivePercent(store, defaultPercent)
  return applyPriceRule(cost, percent)
}

export function formatMoney(value) {
  const n = toNumber(value)
  if (n === null) return '-'
  return `£${n.toFixed(2)}`
}

export function parsePriceRuleInput(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new Error('Price rule percent must be a number')
  }
  return n
}
