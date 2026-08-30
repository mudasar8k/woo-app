import db from './db'

const DEFAULT_PRICE_RULE_KEY = 'default_price_rule_percent'

/**
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getAppSetting(key) {
  const result = await db.query(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [key]
  )
  if (result.rows.length === 0) return null
  return result.rows[0].value
}

/**
 * @param {string} key
 * @param {string|null} value
 */
export async function setAppSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  )
}

/**
 * Global default markup % (super admin). Null = no default markup.
 * @returns {Promise<number|null>}
 */
export async function getDefaultPriceRulePercent() {
  const raw = await getAppSetting(DEFAULT_PRICE_RULE_KEY)
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {number|null} percent
 */
export async function setDefaultPriceRulePercent(percent) {
  const value = percent === null || percent === undefined ? null : String(percent)
  await setAppSetting(DEFAULT_PRICE_RULE_KEY, value)
}

/**
 * Effective markup for a store: store override wins, else global default.
 *
 * @param {{ price_rule_percent?: any }|null|undefined} store
 * @param {number|null|undefined} [defaultPercent] - pass if already loaded
 * @returns {Promise<{ effective: number|null, override: number|null, defaultPercent: number|null, isOverride: boolean }>}
 */
export async function getStorePricingContext(store, defaultPercent) {
  const resolvedDefault =
    defaultPercent !== undefined ? defaultPercent : await getDefaultPriceRulePercent()

  const overrideRaw = store?.price_rule_percent
  const override =
    overrideRaw === null || overrideRaw === undefined || overrideRaw === ''
      ? null
      : Number(overrideRaw)
  const hasOverride = override !== null && Number.isFinite(override)

  return {
    effective: hasOverride ? override : resolvedDefault,
    override: hasOverride ? override : null,
    defaultPercent: resolvedDefault,
    isOverride: hasOverride,
  }
}

export { DEFAULT_PRICE_RULE_KEY }
