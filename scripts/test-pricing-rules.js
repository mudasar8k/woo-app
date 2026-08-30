/**
 * Automated Comprehensive Test Suite for Pricing Rules Engine
 *
 * Tests all 10 required domains:
 * 1. Legacy Store 4 +177%, Super-admin default, Sell-at-cost
 * 2. Deterministic Boundaries (0, 5.00, 5.01, 10.00, 10.01, 20.00, 20.01)
 * 3. Open-ended range (50, 50.01, high value)
 * 4. Range gaps (with and without fallback markup)
 * 5. Product overrides (fixed selling price, custom markup, reset)
 * 6. Variation pricing (per-variation cost matching different bands & fixed override)
 * 7. Supplier cost update dynamic recalculation
 * 8. Fractional rounding and round2 arithmetic
 * 9. Validation utility (overlaps, negative markup, max <= min, multiple open ends)
 * 10. 25-Product Snapshot Test comparing legacy vs new resolver under legacy_markup mode
 */

const {
  resolveItemPrice,
  resolveStorePrice,
  applyPriceRule,
  validatePricingRules,
  round2,
  toNumber,
  formatMoney,
} = require('../app/lib/pricing')

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    passed++
    console.log(`  ✓ ${message}`)
  } else {
    failed++
    console.error(`  ✗ FAIL: ${message}`)
  }
}

function assertEqual(actual, expected, message) {
  const match = actual === expected || (Number.isNaN(actual) && Number.isNaN(expected))
  if (match) {
    passed++
    console.log(`  ✓ ${message} [${actual}]`)
  } else {
    failed++
    console.error(`  ✗ FAIL: ${message} (Expected: ${expected}, Actual: ${actual})`)
  }
}

console.log('====================================================')
console.log('RUNNING PRICING RULES COMPREHENSIVE TEST SUITE')
console.log('====================================================\n')

// ── 1. LEGACY PRICING TESTS ──────────────────────────────────────────────────
console.log('--- 1. LEGACY PRICING TESTS ---')
{
  const store4Legacy = { pricing_mode: 'legacy_markup', price_rule_percent: 177.0 }
  const res1 = resolveItemPrice(10.0, store4Legacy)
  // 10.00 * (1 + 1.77) = 27.70
  assertEqual(res1.sellingPrice, 27.7, 'Store 4 +177% on £10.00')
  assertEqual(res1.source, 'store_legacy_override', 'Source is store_legacy_override')

  const res2 = resolveItemPrice(4.71, store4Legacy)
  // 4.71 * 2.77 = 13.0467 -> 13.05
  assertEqual(res2.sellingPrice, 13.05, 'Store 4 +177% on £4.71')

  const superAdminStore = { pricing_mode: 'legacy_markup', price_rule_percent: null, default_price_rule_percent: 50.0 }
  const res3 = resolveItemPrice(20.0, superAdminStore)
  assertEqual(res3.sellingPrice, 30.0, 'Super-admin fallback +50% on £20.00')
  assertEqual(res3.source, 'super_admin_default', 'Source is super_admin_default')

  const noMarkupStore = { pricing_mode: 'legacy_markup', price_rule_percent: null, default_price_rule_percent: null }
  const res4 = resolveItemPrice(15.5, noMarkupStore)
  assertEqual(res4.sellingPrice, 15.5, 'No markup store sells at cost £15.50')
  assertEqual(res4.source, 'cost_price', 'Source is cost_price')
}

// ── 2. DETERMINISTIC BOUNDARIES TESTS ─────────────────────────────────────────
console.log('\n--- 2. DETERMINISTIC BOUNDARIES TESTS ---')
{
  const sampleRules = [
    { id: 1, min_cost: 0, max_cost: 5, markup_percent: 177 },    // 0 <= cost <= 5
    { id: 2, min_cost: 5, max_cost: 10, markup_percent: 100 },   // 5 < cost <= 10
    { id: 3, min_cost: 10, max_cost: 20, markup_percent: 75 },   // 10 < cost <= 20
    { id: 4, min_cost: 20, max_cost: 50, markup_percent: 50 },   // 20 < cost <= 50
    { id: 5, min_cost: 50, max_cost: null, markup_percent: 35 }, // cost > 50
  ]
  const context = { pricing_mode: 'range_rules', fallback_markup_percent: 40 }

  // cost = 0 -> rule 1 (+177%) -> 0.00
  const r0 = resolveItemPrice(0, context, sampleRules)
  assertEqual(r0.sellingPrice, 0.0, 'Cost £0.00 matches Rule 1')
  assertEqual(r0.matchedRuleId, 1, 'Matched rule #1')

  // cost = 5.00 -> rule 1 (+177%) -> 5.00 * 2.77 = 13.85
  const r5_00 = resolveItemPrice(5.0, context, sampleRules)
  assertEqual(r5_00.sellingPrice, 13.85, 'Cost £5.00 matches Rule 1 (+177%)')
  assertEqual(r5_00.matchedRuleId, 1, 'Matched rule #1')

  // cost = 5.01 -> rule 2 (+100%) -> 5.01 * 2.00 = 10.02
  const r5_01 = resolveItemPrice(5.01, context, sampleRules)
  assertEqual(r5_01.sellingPrice, 10.02, 'Cost £5.01 matches Rule 2 (+100%)')
  assertEqual(r5_01.matchedRuleId, 2, 'Matched rule #2')

  // cost = 10.00 -> rule 2 (+100%) -> 10.00 * 2.00 = 20.00
  const r10_00 = resolveItemPrice(10.0, context, sampleRules)
  assertEqual(r10_00.sellingPrice, 20.0, 'Cost £10.00 matches Rule 2 (+100%)')
  assertEqual(r10_00.matchedRuleId, 2, 'Matched rule #2')

  // cost = 10.01 -> rule 3 (+75%) -> 10.01 * 1.75 = 17.5175 -> 17.52
  const r10_01 = resolveItemPrice(10.01, context, sampleRules)
  assertEqual(r10_01.sellingPrice, 17.52, 'Cost £10.01 matches Rule 3 (+75%)')
  assertEqual(r10_01.matchedRuleId, 3, 'Matched rule #3')

  // cost = 20.00 -> rule 3 (+75%) -> 20.00 * 1.75 = 35.00
  const r20_00 = resolveItemPrice(20.0, context, sampleRules)
  assertEqual(r20_00.sellingPrice, 35.0, 'Cost £20.00 matches Rule 3 (+75%)')
  assertEqual(r20_00.matchedRuleId, 3, 'Matched rule #3')

  // cost = 20.01 -> rule 4 (+50%) -> 20.01 * 1.50 = 30.015 -> 30.02
  const r20_01 = resolveItemPrice(20.01, context, sampleRules)
  assertEqual(r20_01.sellingPrice, 30.02, 'Cost £20.01 matches Rule 4 (+50%)')
  assertEqual(r20_01.matchedRuleId, 4, 'Matched rule #4')
}

// ── 3. OPEN-ENDED RANGE TESTS ────────────────────────────────────────────────
console.log('\n--- 3. OPEN-ENDED RANGE TESTS ---')
{
  const sampleRules = [
    { id: 1, min_cost: 0, max_cost: 50, markup_percent: 50 },
    { id: 2, min_cost: 50, max_cost: null, markup_percent: 35 },
  ]
  const context = { pricing_mode: 'range_rules' }

  // cost = 50.00 -> rule 1 (+50%) -> 75.00
  const r50 = resolveItemPrice(50.0, context, sampleRules)
  assertEqual(r50.sellingPrice, 75.0, 'Cost £50.00 matches Rule 1')
  assertEqual(r50.matchedRuleId, 1, 'Matched rule #1')

  // cost = 50.01 -> rule 2 (+35%) -> 50.01 * 1.35 = 67.5135 -> 67.51
  const r50_01 = resolveItemPrice(50.01, context, sampleRules)
  assertEqual(r50_01.sellingPrice, 67.51, 'Cost £50.01 matches Open-ended Rule 2')
  assertEqual(r50_01.matchedRuleId, 2, 'Matched rule #2')

  // cost = 250.00 -> rule 2 (+35%) -> 250.00 * 1.35 = 337.50
  const r250 = resolveItemPrice(250.0, context, sampleRules)
  assertEqual(r250.sellingPrice, 337.5, 'Cost £250.00 matches Open-ended Rule 2')
  assertEqual(r250.matchedRuleId, 2, 'Matched rule #2')
}

// ── 4. RANGE GAPS & FALLBACK TESTS ───────────────────────────────────────────
console.log('\n--- 4. RANGE GAPS & FALLBACK TESTS ---')
{
  const gappedRules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 },
    // Gap: 10 to 20 has no rule!
    { id: 2, min_cost: 20, max_cost: 50, markup_percent: 50 },
  ]

  // Cost in gap with fallback configured:
  const contextWithFallback = { pricing_mode: 'range_rules', fallback_markup_percent: 30 }
  const rGap15 = resolveItemPrice(15.0, contextWithFallback, gappedRules)
  // 15.00 * 1.30 = 19.50
  assertEqual(rGap15.sellingPrice, 19.5, 'Gap cost £15.00 uses fallback markup (+30%)')
  assertEqual(rGap15.source, 'store_fallback_markup', 'Source is store_fallback_markup')

  // Cost in gap without fallback but with legacy store override:
  const contextWithLegacy = { pricing_mode: 'range_rules', fallback_markup_percent: null, price_rule_percent: 177 }
  const rGapLegacy = resolveItemPrice(15.0, contextWithLegacy, gappedRules)
  // 15.00 * 2.77 = 41.55
  assertEqual(rGapLegacy.sellingPrice, 41.55, 'Gap cost £15.00 falls back to legacy override (+177%)')
  assertEqual(rGapLegacy.source, 'store_legacy_override', 'Source is store_legacy_override')
}

// ── 5. PRODUCT OVERRIDE TESTS ────────────────────────────────────────────────
console.log('\n--- 5. PRODUCT OVERRIDE TESTS ---')
{
  const storeContext = { pricing_mode: 'range_rules', price_rule_percent: 177 }
  const rules = [{ id: 1, min_cost: 0, max_cost: 100, markup_percent: 50 }]

  // Product Override: Fixed Price £49.99
  const fixedOverride = { override_type: 'fixed_price', fixed_price: 49.99 }
  const resFixed = resolveItemPrice(12.0, storeContext, rules, fixedOverride)
  assertEqual(resFixed.sellingPrice, 49.99, 'Product Fixed Price override £49.99 applied')
  assertEqual(resFixed.source, 'product_fixed', 'Source is product_fixed')

  // Product Override: Custom Markup 80%
  const customMarkupOverride = { override_type: 'custom_markup', custom_markup_percent: 80 }
  const resCustom = resolveItemPrice(10.0, storeContext, rules, customMarkupOverride)
  // 10.00 * 1.80 = 18.00
  assertEqual(resCustom.sellingPrice, 18.0, 'Product Custom Markup (+80%) applied')
  assertEqual(resCustom.source, 'product_custom_markup', 'Source is product_custom_markup')

  // Product Override: Reset / Store Rules
  const resetOverride = { override_type: 'store_rules' }
  const resReset = resolveItemPrice(10.0, storeContext, rules, resetOverride)
  // Range rule: 10.00 * 1.50 = 15.00
  assertEqual(resReset.sellingPrice, 15.0, 'Reset override correctly falls back to store range rule')
  assertEqual(resReset.source, 'range_rule', 'Source is range_rule')
}

// ── 6. VARIATION PRICING TESTS ───────────────────────────────────────────────
console.log('\n--- 6. VARIATION PRICING TESTS ---')
{
  const rules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 }, // £0-£10 -> +100%
    { id: 2, min_cost: 10, max_cost: 20, markup_percent: 75 }, // £10-£20 -> +75%
  ]
  const context = { pricing_mode: 'range_rules' }

  // Variation A: S-XL cost £8.00 -> band 1 (+100%) -> £16.00
  const varA = resolveStorePrice({ price: 8.0 }, context, null, null, rules)
  assertEqual(varA, 16.0, 'Variation A (£8.00 cost) priced at £16.00 (+100%)')

  // Variation B: 2XL-5XL cost £12.00 -> band 2 (+75%) -> £21.00
  const varB = resolveStorePrice({ price: 12.0 }, context, null, null, rules)
  assertEqual(varB, 21.0, 'Variation B (£12.00 cost) priced at £21.00 (+75%)')

  // With fixed price override on parent: both variations get £25.00
  const fixedOverride = { override_type: 'fixed_price', fixed_price: 25.0 }
  const varAFixed = resolveStorePrice({ price: 8.0 }, context, null, fixedOverride, rules)
  const varBFixed = resolveStorePrice({ price: 12.0 }, context, null, fixedOverride, rules)
  assertEqual(varAFixed, 25.0, 'Variation A inherits fixed override £25.00')
  assertEqual(varBFixed, 25.0, 'Variation B inherits fixed override £25.00')
}

// ── 7. SUPPLIER COST UPDATE TESTS ────────────────────────────────────────────
console.log('\n--- 7. SUPPLIER COST UPDATE TESTS ---')
{
  const rules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 },
    { id: 2, min_cost: 10, max_cost: 20, markup_percent: 50 },
  ]
  const context = { pricing_mode: 'range_rules' }

  let productCost = 9.5 // matches rule 1 (+100%)
  const priceBefore = resolveStorePrice({ price: productCost }, context, null, null, rules)
  assertEqual(priceBefore, 19.0, 'Initial cost £9.50 -> £19.00')

  // Ralawise sync updates supplier cost to £10.50 (crosses into band 2 +50%)
  productCost = 10.5
  const priceAfter = resolveStorePrice({ price: productCost }, context, null, null, rules)
  // 10.50 * 1.50 = 15.75
  assertEqual(priceAfter, 15.75, 'Updated cost £10.50 automatically moves to Rule 2 -> £15.75')
}

// ── 8. FRACTIONAL & ROUNDING TESTS ───────────────────────────────────────────
console.log('\n--- 8. FRACTIONAL & ROUNDING TESTS ---')
{
  assertEqual(round2(10.004), 10.0, 'Round down 10.004 -> 10.00')
  assertEqual(round2(10.005), 10.01, 'Round half-up 10.005 -> 10.01')
  assertEqual(round2(10.006), 10.01, 'Round up 10.006 -> 10.01')

  const fractionalCost = 3.333
  const context = { pricing_mode: 'legacy_markup', price_rule_percent: 33.33 }
  const res = resolveItemPrice(fractionalCost, context)
  // 3.333 * 1.3333 = 4.4438889 -> 4.44
  assertEqual(res.sellingPrice, 4.44, 'Fractional cost and markup rounds to £4.44')
}

// ── 9. PRICING RULES VALIDATION UTILITY TESTS ─────────────────────────────────
console.log('\n--- 9. PRICING RULES VALIDATION UTILITY TESTS ---')
{
  // Valid continuous rules
  const validRules = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 10, max_cost: 20, markup_percent: 75 },
    { min_cost: 20, max_cost: null, markup_percent: 50 },
  ]
  const v1 = validatePricingRules(validRules)
  assert(v1.valid === true, 'Valid rules pass validation')
  assert(v1.hasGaps === false, 'No gaps detected')

  // Overlapping rules
  const overlappingRules = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 8, max_cost: 20, markup_percent: 75 }, // Overlaps at 8-10!
  ]
  const v2 = validatePricingRules(overlappingRules)
  assert(v2.valid === false, 'Overlapping rules rejected')
  assert(v2.errors.some((e) => e.includes('Overlapping ranges detected')), 'Correct overlap error emitted')

  // Negative markup
  const negMarkupRules = [{ min_cost: 0, max_cost: 10, markup_percent: -10 }]
  const v3 = validatePricingRules(negMarkupRules)
  assert(v3.valid === false, 'Negative markup rejected')

  // max_cost <= min_cost
  const invertedRules = [{ min_cost: 20, max_cost: 10, markup_percent: 50 }]
  const v4 = validatePricingRules(invertedRules)
  assert(v4.valid === false, 'Inverted max <= min rejected')

  // Multiple open-ended rules
  const multiOpen = [
    { min_cost: 0, max_cost: null, markup_percent: 100 },
    { min_cost: 50, max_cost: null, markup_percent: 50 },
  ]
  const v5 = validatePricingRules(multiOpen)
  assert(v5.valid === false, 'Multiple open-ended rules rejected')

  // Rule after open-ended rule
  const ruleAfterOpen = [
    { min_cost: 0, max_cost: null, markup_percent: 100 },
    { min_cost: 20, max_cost: 50, markup_percent: 50 },
  ]
  const v6 = validatePricingRules(ruleAfterOpen)
  assert(v6.valid === false, 'Rule after open-ended rule rejected')

  // Gap detection
  const gapRules = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 15, max_cost: 30, markup_percent: 50 },
  ]
  const v7 = validatePricingRules(gapRules, { requireContinuous: true, fallbackMarkup: null })
  assert(v7.hasGaps === true, 'Gaps detected between 10 and 15')
  assert(v7.valid === false, 'Gap rejected when continuous required without fallback')
}

// ── 10. 25-PRODUCT SNAPSHOT COMPARISON TEST ──────────────────────────────────
console.log('\n--- 10. 25-PRODUCT SNAPSHOT TEST (LEGACY VS NEW RESOLVER) ---')
{
  const testCatalog = [
    { id: 1, sku: 'TS030', cost: 11.77 },
    { id: 2, sku: 'AT001', cost: 4.71 },
    { id: 3, sku: 'BA306', cost: 2.15 },
    { id: 4, sku: 'JH001', cost: 8.95 },
    { id: 5, sku: 'GD001', cost: 3.49 },
    { id: 6, sku: 'BB001', cost: 1.85 },
    { id: 7, sku: 'FX001', cost: 14.50 },
    { id: 8, sku: 'JK001', cost: 32.90 },
    { id: 9, sku: 'PR001', cost: 6.20 },
    { id: 10, sku: 'RW001', cost: 0.99 },
    { id: 11, sku: 'UC101', cost: 5.40 },
    { id: 12, sku: 'KK100', cost: 7.80 },
    { id: 13, sku: 'RH010', cost: 19.99 },
    { id: 14, sku: 'SG020', cost: 45.00 },
    { id: 15, sku: 'TR030', cost: 68.50 },
    { id: 16, sku: 'HV001', cost: 12.35 },
    { id: 17, sku: 'AQ005', cost: 24.10 },
    { id: 18, sku: 'WN010', cost: 88.00 },
    { id: 19, sku: 'CP001', cost: 1.15 },
    { id: 20, sku: 'SK001', cost: 16.75 },
    { id: 21, sku: 'VR-BLK-S', cost: 7.25 },
    { id: 22, sku: 'VR-BLK-M', cost: 7.25 },
    { id: 23, sku: 'VR-BLK-L', cost: 7.25 },
    { id: 24, sku: 'VR-BLK-2XL', cost: 9.80 },
    { id: 25, sku: 'VR-BLK-3XL', cost: 11.20 },
  ]

  const store4Legacy = { id: 4, name: 'Southline', pricing_mode: 'legacy_markup', price_rule_percent: 177.0 }

  let mismatchCount = 0

  for (const item of testCatalog) {
    // 1. Legacy calculation
    const legacyPrice = applyPriceRule(item.cost, 177.0)

    // 2. New resolver with legacy_markup mode
    const newPrice = resolveStorePrice({ regular_price: item.cost }, store4Legacy)

    if (legacyPrice !== newPrice) {
      mismatchCount++
      console.error(`  ✗ MISMATCH on SKU ${item.sku}: Legacy=${legacyPrice}, New=${newPrice}`)
    }
  }

  assertEqual(mismatchCount, 0, '25/25 products produced 100% identical selling prices (0 price drift)')
}

console.log('\n====================================================')
console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`)
console.log('====================================================')

if (failed > 0) {
  process.exit(1)
}
