/**
 * Centralized Store Pricing Engine
 *
 * Supports:
 * 1. Product fixed selling-price override
 * 2. Product custom markup % override
 * 3. Store Category pricing rules (with priority ordering)
 * 4. Store price-range rules (deterministic boundaries: min < cost <= max, with 0 <= cost <= max for 0-min)
 * 5. Store fallback markup % (for price range gaps)
 * 6. Store legacy markup % override (e.g. Store 4 +177%)
 * 7. Super-admin global default markup %
 * 8. Fallback to cost (sell = cost)
 */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : parseFloat(String(value).trim())
  return Number.isFinite(num) ? num : null
}

function round2(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return null
  return Math.round((Number(num) + Number.EPSILON) * 100) / 100
}

function formatMoney(amount, currency = '£') {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '-'
  const num = typeof amount === 'number' ? amount : parseFloat(amount)
  if (!Number.isFinite(num)) return '-'
  return `${currency}${num.toFixed(2)}`
}

function resolveCostPrice(row) {
  if (!row) return null
  const regular = toNumber(row.regular_price)
  if (regular !== null) return regular
  const price = toNumber(row.price)
  if (price !== null) return price
  const sale = toNumber(row.sale_price)
  if (sale !== null) return sale
  return null
}

function sortPricingRules(rules = []) {
  if (!Array.isArray(rules)) return []
  return [...rules].sort((a, b) => {
    const minA = toNumber(a.min_cost) ?? 0
    const minB = toNumber(b.min_cost) ?? 0
    if (minA !== minB) return minA - minB
    const maxA = toNumber(a.max_cost) ?? Infinity
    const maxB = toNumber(b.max_cost) ?? Infinity
    return maxA - maxB
  })
}

function validatePricingRules(rules, options = {}) {
  const errors = []
  if (!Array.isArray(rules) || rules.length === 0) {
    return { valid: true, errors: [], sortedRules: [], hasGaps: false, gaps: [] }
  }

  const sortedRules = sortPricingRules(rules)
  let openEndedFound = false
  const gaps = []

  for (let i = 0; i < sortedRules.length; i++) {
    const rule = sortedRules[i]
    const min = toNumber(rule.min_cost)
    const max = rule.max_cost !== null && rule.max_cost !== undefined && rule.max_cost !== '' ? toNumber(rule.max_cost) : null
    const markup = toNumber(rule.markup_percent)

    if (min === null || min < 0) {
      errors.push(`Rule #${i + 1}: Minimum cost must be a non-negative number.`)
    }

    if (markup === null || markup < 0) {
      errors.push(`Rule #${i + 1}: Markup percent must be a non-negative number.`)
    }

    if (max !== null) {
      if (min !== null && max <= min) {
        errors.push(`Rule #${i + 1}: Maximum cost (£${max}) must be greater than minimum cost (£${min}).`)
      }
    } else {
      if (openEndedFound) {
        errors.push(`Rule #${i + 1}: Only one open-ended rule (with no upper limit) is allowed.`)
      }
      openEndedFound = true
    }

    if (openEndedFound && i < sortedRules.length - 1) {
      errors.push(`Rule #${i + 2}: Cannot configure additional rules after an open-ended rule.`)
    }

    // Check overlap & gaps with subsequent rule
    if (i < sortedRules.length - 1) {
      const nextRule = sortedRules[i + 1]
      const nextMin = toNumber(nextRule.min_cost)

      if (max !== null && nextMin !== null) {
        if (nextMin < max) {
          errors.push(
            `Overlapping ranges detected: Rule [£${min} to £${max}] overlaps with next rule starting at £${nextMin}.`
          )
        } else if (nextMin > max) {
          gaps.push({ from: max, to: nextMin })
        }
      }
    }
  }

  // Check if highest rule has a finite upper bound without fallback
  if (sortedRules.length > 0 && !openEndedFound) {
    const lastRule = sortedRules[sortedRules.length - 1]
    const lastMax = toNumber(lastRule.max_cost)
    if (lastMax !== null) {
      gaps.push({ from: lastMax, to: 'No Limit' })
    }
  }

  const hasGaps = gaps.length > 0
  if (hasGaps && options.requireContinuous && (options.fallbackMarkup === null || options.fallbackMarkup === undefined)) {
    errors.push(
      `Price ranges have gaps or uncovered upper limits (${gaps.map((g) => `£${g.from}–${g.to === 'No Limit' ? 'No Limit' : `£${g.to}`}`).join(', ')}). Add an open-ended range or configure a fallback markup %.`
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    sortedRules,
    hasGaps,
    gaps,
  }
}

/**
 * Splits and normalizes comma-separated category string or array into distinct tokens.
 *
 * @param {string|Array<string>|null|undefined} rawCategories
 * @returns {Array<string>}
 */
function parseCategoryTokens(rawCategories) {
  if (!rawCategories) return []
  if (Array.isArray(rawCategories)) {
    return rawCategories.map((c) => String(c).trim()).filter(Boolean)
  }
  return String(rawCategories)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
}

/**
 * Matches product categories against active store category pricing rules using exact token matching.
 * If multiple rules match, returns the rule with the lowest priority value (highest priority).
 *
 * @param {string|Array<string>} productCategories
 * @param {Array<object>} categoryRules
 * @returns {object|null} Matched category rule or null
 */
function matchCategoryPricingRule(productCategories, categoryRules) {
  if (!Array.isArray(categoryRules) || categoryRules.length === 0) {
    return null
  }

  const tokens = parseCategoryTokens(productCategories).map((t) => t.toLowerCase())
  if (tokens.length === 0) {
    return null
  }

  const matchedRules = []
  for (const rule of categoryRules) {
    if (rule.active === false) continue
    const ruleCat = String(rule.category || '').trim().toLowerCase()
    if (!ruleCat) continue

    if (tokens.includes(ruleCat)) {
      matchedRules.push(rule)
    }
  }

  if (matchedRules.length === 0) {
    return null
  }

  matchedRules.sort((a, b) => {
    const pA = Number(a.priority) || 0
    const pB = Number(b.priority) || 0
    if (pA !== pB) return pA - pB
    return (Number(a.id) || 0) - (Number(b.id) || 0)
  })

  return matchedRules[0]
}

/**
 * Pure Centralized Pricing Resolver with Category-Based Rules.
 *
 * Priority Hierarchy:
 * 1. Product fixed selling-price override
 * 2. Product custom markup % override
 * 3. Store Category pricing rules (with priority ordering)
 * 4. Store price-range rules (when pricing_mode === 'range_rules')
 * 5. Store fallback markup % (when pricing_mode === 'range_rules' and cost falls in a gap)
 * 6. Store legacy markup % override (stores.price_rule_percent)
 * 7. Super-admin default markup % (app_settings.default_price_rule_percent)
 * 8. Cost price fallback (sell = cost)
 */
function resolveItemPrice(
  rawCost,
  storeContext = {},
  rangeRules = [],
  productOverride = null,
  productCategories = null,
  categoryRules = []
) {
  const cost = toNumber(rawCost)
  if (cost === null) {
    return {
      sellingPrice: null,
      source: 'cost_price',
      appliedMarkup: null,
      matchedRuleId: null,
      matchedCategoryRuleId: null,
      matchedCategory: null,
      cost: null,
    }
  }

  // ── Priority 1: Product Fixed Selling Price ─────────────────────────────
  if (productOverride && productOverride.override_type === 'fixed_price') {
    const fixedPrice = toNumber(productOverride.fixed_price)
    if (fixedPrice !== null && fixedPrice >= 0) {
      return {
        sellingPrice: round2(fixedPrice),
        source: 'product_fixed',
        appliedMarkup: null,
        matchedRuleId: null,
        matchedCategoryRuleId: null,
        matchedCategory: null,
        cost,
      }
    }
  }

  // ── Priority 2: Product Custom Markup % ─────────────────────────────────
  if (productOverride && productOverride.override_type === 'custom_markup') {
    const customMarkup = toNumber(productOverride.custom_markup_percent)
    if (customMarkup !== null && customMarkup >= 0) {
      return {
        sellingPrice: round2(cost * (1 + customMarkup / 100)),
        source: 'product_custom_markup',
        appliedMarkup: customMarkup,
        matchedRuleId: null,
        matchedCategoryRuleId: null,
        matchedCategory: null,
        cost,
      }
    }
  }

  // ── Priority 3: Store Category Pricing Rules ────────────────────────────
  const matchedCatRule = matchCategoryPricingRule(productCategories, categoryRules)
  if (matchedCatRule) {
    const catMarkup = toNumber(matchedCatRule.markup_percent)
    if (catMarkup !== null && catMarkup >= 0) {
      return {
        sellingPrice: round2(cost * (1 + catMarkup / 100)),
        source: 'category_rule',
        appliedMarkup: catMarkup,
        matchedRuleId: null,
        matchedCategoryRuleId: matchedCatRule.id || null,
        matchedCategory: matchedCatRule.category,
        cost,
      }
    }
  }

  // ── Priority 4: Store Price Ranges (when pricing_mode === 'range_rules') ─
  const pricingMode = storeContext.pricing_mode || 'legacy_markup'

  if (pricingMode === 'range_rules' && Array.isArray(rangeRules) && rangeRules.length > 0) {
    const activeRules = rangeRules.filter((r) => r.active !== false)
    const sorted = sortPricingRules(activeRules)

    for (const rule of sorted) {
      const min = toNumber(rule.min_cost) ?? 0
      const max = toNumber(rule.max_cost)
      const markup = toNumber(rule.markup_percent) ?? 0

      let matches = false
      if (min === 0) {
        matches = max === null ? cost >= 0 : cost >= 0 && cost <= max
      } else {
        matches = max === null ? cost > min : cost > min && cost <= max
      }

      if (matches) {
        return {
          sellingPrice: round2(cost * (1 + markup / 100)),
          source: 'range_rule',
          appliedMarkup: markup,
          matchedRuleId: rule.id || null,
          matchedCategoryRuleId: null,
          matchedCategory: null,
          cost,
        }
      }
    }
  }

  // ── Priority 5: Store Fallback Markup % (for gaps) ──────────────────────
  if (pricingMode === 'range_rules') {
    const fallback = toNumber(storeContext.fallback_markup_percent)
    if (fallback !== null && fallback >= 0) {
      return {
        sellingPrice: round2(cost * (1 + fallback / 100)),
        source: 'store_fallback_markup',
        appliedMarkup: fallback,
        matchedRuleId: null,
        matchedCategoryRuleId: null,
        matchedCategory: null,
        cost,
      }
    }
  }

  // ── Priority 6: Store Legacy Markup Override ────────────────────────────
  const storeOverride = toNumber(storeContext.price_rule_percent)
  if (storeOverride !== null) {
    return {
      sellingPrice: round2(cost * (1 + storeOverride / 100)),
      source: 'store_legacy_override',
      appliedMarkup: storeOverride,
      matchedRuleId: null,
      matchedCategoryRuleId: null,
      matchedCategory: null,
      cost,
    }
  }

  // ── Priority 7: Super-Admin Global Default ──────────────────────────────
  const defaultPercent = toNumber(storeContext.default_price_rule_percent ?? storeContext.defaultPercent)
  if (defaultPercent !== null) {
    return {
      sellingPrice: round2(cost * (1 + defaultPercent / 100)),
      source: 'super_admin_default',
      appliedMarkup: defaultPercent,
      matchedRuleId: null,
      matchedCategoryRuleId: null,
      matchedCategory: null,
      cost,
    }
  }

  // ── Priority 8: Cost Price Fallback ─────────────────────────────────────
  return {
    sellingPrice: round2(cost),
    source: 'cost_price',
    appliedMarkup: 0,
    matchedRuleId: null,
    matchedCategoryRuleId: null,
    matchedCategory: null,
    cost,
  }
}

function applyPriceRule(costPrice, percent) {
  const cost = toNumber(costPrice)
  if (cost === null) return null
  const pct = toNumber(percent)
  if (pct === null) return round2(cost)
  return round2(cost * (1 + pct / 100))
}

function resolveEffectivePercent(store, defaultPercent = null) {
  const override = toNumber(store?.price_rule_percent)
  if (override !== null) return override
  return toNumber(defaultPercent)
}

function resolveStorePrice(
  row,
  store = {},
  defaultPercent = null,
  productOverride = null,
  rangeRules = [],
  productCategories = null,
  categoryRules = []
) {
  const cost = resolveCostPrice(row)
  if (cost === null) return null

  const storeContext = {
    pricing_mode: store?.pricing_mode || 'legacy_markup',
    price_rule_percent: store?.price_rule_percent,
    fallback_markup_percent: store?.fallback_markup_percent,
    default_price_rule_percent: defaultPercent ?? store?.default_price_rule_percent,
    defaultPercent: defaultPercent ?? store?.defaultPercent,
  }

  const result = resolveItemPrice(
    cost,
    storeContext,
    rangeRules,
    productOverride,
    productCategories || row?.categories,
    categoryRules
  )
  return result.sellingPrice
}

/**
 * Loads the store's full pricing engine context (store mode, rates, default, active range rules, active category rules).
 *
 * @param {object} db - Database client/pool
 * @param {number} storeId - Store ID
 * @returns {Promise<{ storeContext: object, rangeRules: Array<object>, categoryRules: Array<object> }>}
 */
async function loadStorePricingEngine(db, storeId) {
  let store = null
  try {
    const storeRes = await db.query(
      'SELECT id, name, price_rule_percent, pricing_mode, fallback_markup_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeRes.rows.length > 0) {
      store = storeRes.rows[0]
    }
  } catch {
    const storeRes = await db.query(
      'SELECT id, name, price_rule_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeRes.rows.length > 0) {
      store = storeRes.rows[0]
    }
  }

  if (!store) {
    return {
      storeContext: {
        pricing_mode: 'legacy_markup',
        price_rule_percent: null,
        fallback_markup_percent: null,
        default_price_rule_percent: null,
        defaultPercent: null,
      },
      rangeRules: [],
      categoryRules: [],
    }
  }

  let defaultPercent = null
  try {
    const setting = await db.query(
      "SELECT value FROM app_settings WHERE key = 'default_price_rule_percent' LIMIT 1"
    )
    if (setting.rows.length > 0 && setting.rows[0].value !== null && setting.rows[0].value !== '') {
      const n = Number(setting.rows[0].value)
      defaultPercent = Number.isFinite(n) ? n : null
    }
  } catch {
    defaultPercent = null
  }

  let rangeRules = []
  try {
    const rulesRes = await db.query(
      'SELECT id, min_cost, max_cost, markup_percent, active FROM store_pricing_rules WHERE store_id = $1 AND active = true ORDER BY min_cost ASC',
      [storeId]
    )
    rangeRules = rulesRes.rows.map((r) => ({
      id: r.id,
      min_cost: Number(r.min_cost),
      max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
      markup_percent: Number(r.markup_percent),
      active: r.active,
    }))
  } catch {
    rangeRules = []
  }

  let categoryRules = []
  try {
    const catRes = await db.query(
      'SELECT id, store_id, category, markup_percent, priority, active FROM store_category_pricing_rules WHERE store_id = $1 AND active = true ORDER BY priority ASC, id ASC',
      [storeId]
    )
    categoryRules = catRes.rows.map((r) => ({
      id: r.id,
      store_id: r.store_id,
      category: r.category,
      markup_percent: Number(r.markup_percent),
      priority: Number(r.priority) || 0,
      active: r.active,
    }))
  } catch {
    categoryRules = []
  }

  const storeContext = {
    pricing_mode: store.pricing_mode || 'legacy_markup',
    price_rule_percent: store.price_rule_percent !== null && store.price_rule_percent !== undefined ? Number(store.price_rule_percent) : null,
    fallback_markup_percent: store.fallback_markup_percent !== null && store.fallback_markup_percent !== undefined ? Number(store.fallback_markup_percent) : null,
    default_price_rule_percent: defaultPercent,
    defaultPercent,
  }

  return { storeContext, rangeRules, categoryRules }
}

/**
 * Batch-loads product store pricing overrides for an array of product IDs in a single query.
 *
 * @param {object} db - Database client/pool
 * @param {number} storeId - Store ID
 * @param {Array<number>} productIds - Array of product IDs
 * @returns {Promise<Map<number, object>>} Map of productId => override object
 */
async function loadProductStoreOverrides(db, storeId, productIds) {
  const map = new Map()
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return map
  }

  try {
    const res = await db.query(
      'SELECT product_id, override_type, custom_markup_percent, fixed_price FROM product_store_pricing WHERE store_id = $1 AND product_id = ANY($2::int[])',
      [storeId, productIds]
    )
    for (const row of res.rows) {
      map.set(row.product_id, {
        override_type: row.override_type,
        custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
        fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
      })
    }
  } catch {
    // Table may not exist or query failed, return empty map
  }

  return map
}

module.exports = {
  round2,
  toNumber,
  formatMoney,
  resolveCostPrice,
  resolveEffectivePercent,
  applyPriceRule,
  resolveStorePrice,
  sortPricingRules,
  validatePricingRules,
  parseCategoryTokens,
  matchCategoryPricingRule,
  resolveItemPrice,
  loadStorePricingEngine,
  loadProductStoreOverrides,
}
