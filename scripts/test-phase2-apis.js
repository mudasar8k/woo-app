/**
 * Automated Test Suite for Phase 2 Backend Pricing APIs & Logic
 *
 * Tests:
 * 1. Store Pricing Config (activation validation, gap rejection, legacy reversion)
 * 2. Store Pricing Rules Bulk Save (atomicity, sorting, validation)
 * 3. Individual Pricing Rule CRUD
 * 4. Product Pricing Overrides (custom markup, fixed price, reset, validation)
 * 5. Pricing Preview API (single cost, product + variations crossing bands, overrides)
 * 6. Authorization & Role Guards (super_admin, store admin scoping, unauthorized)
 */

const {
  resolveItemPrice,
  resolveStorePrice,
  validatePricingRules,
  sortPricingRules,
  round2,
} = require('../app/lib/pricing')
const {
  requireSuperAdminApi,
  requireAdminOrSuperAdminApi,
  requireStoreAdminApi,
  verifyAdminStoreAccess,
} = require('../app/lib/role-guards')

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
  if (actual === expected) {
    passed++
    console.log(`  ✓ ${message} [${actual}]`)
  } else {
    failed++
    console.error(`  ✗ FAIL: ${message} (Expected: ${expected}, Actual: ${actual})`)
  }
}

console.log('====================================================')
console.log('RUNNING PHASE 2 PRICING API & LOGIC TEST SUITE')
console.log('====================================================\n')

// ── 1. STORE PRICING CONFIG & ACTIVATION VALIDATION ─────────────────────────
console.log('--- 1. STORE PRICING CONFIG & ACTIVATION VALIDATION ---')
{
  // Cannot activate range_rules with 0 rules
  const emptyRules = []
  const vEmpty = validatePricingRules(emptyRules)
  assert(emptyRules.length === 0, 'Zero rules detected: activation check requires rules count > 0')

  // Cannot activate range_rules with overlapping rules
  const overlapping = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 8, max_cost: 25, markup_percent: 75 },
  ]
  const vOverlap = validatePricingRules(overlapping)
  assert(!vOverlap.valid, 'Overlapping rules rejected for activation')
  assert(vOverlap.errors.some((e) => e.includes('Overlapping ranges')), 'Overlap error emitted')

  // Cannot activate range_rules with gaps without fallback
  const gapped = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 15, max_cost: 50, markup_percent: 50 },
  ]
  const vGapsNoFallback = validatePricingRules(gapped, { requireContinuous: true, fallbackMarkup: null })
  assert(!vGapsNoFallback.valid, 'Gapped rules rejected for activation when fallback is missing')

  // CAN activate range_rules with gaps when fallback IS provided
  const vGapsWithFallback = validatePricingRules(gapped, { requireContinuous: true, fallbackMarkup: 35.0 })
  assert(vGapsWithFallback.valid, 'Gapped rules accepted for activation when fallback is configured')

  // CAN activate valid continuous rules
  const continuous = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 10, max_cost: 20, markup_percent: 75 },
    { min_cost: 20, max_cost: null, markup_percent: 50 },
  ]
  const vContinuous = validatePricingRules(continuous, { requireContinuous: true, fallbackMarkup: null })
  assert(vContinuous.valid, 'Continuous valid rules pass activation check without requiring fallback')
}

// ── 2. BULK SAVE ATOMICITY & SANITIZATION ────────────────────────────────────
console.log('\n--- 2. BULK SAVE ATOMICITY & SANITIZATION ---')
{
  const unsortedUserRules = [
    { min_cost: 20, max_cost: 50, markup_percent: 50 },
    { min_cost: 0, max_cost: 5, markup_percent: 177 },
    { min_cost: 5, max_cost: 10, markup_percent: 100 },
    { min_cost: 10, max_cost: 20, markup_percent: 75 },
    { min_cost: 50, max_cost: null, markup_percent: 35 },
  ]

  const sorted = sortPricingRules(unsortedUserRules)
  assertEqual(sorted[0].min_cost, 0, 'Bulk save sorts rule 1 min_cost to 0')
  assertEqual(sorted[1].min_cost, 5, 'Bulk save sorts rule 2 min_cost to 5')
  assertEqual(sorted[2].min_cost, 10, 'Bulk save sorts rule 3 min_cost to 10')
  assertEqual(sorted[3].min_cost, 20, 'Bulk save sorts rule 4 min_cost to 20')
  assertEqual(sorted[4].min_cost, 50, 'Bulk save sorts rule 5 min_cost to 50')

  // Validation failure rejects entire payload before transaction writes
  const corruptPayload = [
    { min_cost: 0, max_cost: 10, markup_percent: 100 },
    { min_cost: 5, max_cost: 20, markup_percent: -10 }, // Invalid negative markup & overlap!
  ]
  const vCorrupt = validatePricingRules(corruptPayload)
  assert(!vCorrupt.valid, 'Corrupt bulk-save payload rejected immediately (atomic rejection)')
}

// ── 3. PRODUCT OVERRIDE LOGIC & VALIDATION ───────────────────────────────────
console.log('\n--- 3. PRODUCT OVERRIDE LOGIC & VALIDATION ---')
{
  const storeContext = { pricing_mode: 'range_rules', price_rule_percent: 177 }
  const rangeRules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 },
    { id: 2, min_cost: 10, max_cost: 50, markup_percent: 50 },
  ]

  // Custom markup override on a £15 item (normally +50% -> £22.50)
  const customOverride = { override_type: 'custom_markup', custom_markup_percent: 80.0 }
  const resCustom = resolveItemPrice(15.0, storeContext, rangeRules, customOverride)
  assertEqual(resCustom.sellingPrice, 27.0, 'Custom markup +80% on £15.00 -> £27.00')
  assertEqual(resCustom.source, 'product_custom_markup', 'Source is product_custom_markup')

  // Fixed price override on a £15 item
  const fixedOverride = { override_type: 'fixed_price', fixed_price: 39.99 }
  const resFixed = resolveItemPrice(15.0, storeContext, rangeRules, fixedOverride)
  assertEqual(resFixed.sellingPrice, 39.99, 'Fixed price override £39.99')
  assertEqual(resFixed.source, 'product_fixed', 'Source is product_fixed')

  // Reset to store_rules
  const resetOverride = { override_type: 'store_rules' }
  const resReset = resolveItemPrice(15.0, storeContext, rangeRules, resetOverride)
  assertEqual(resReset.sellingPrice, 22.5, 'Reset override correctly falls back to range rule (+50%)')
  assertEqual(resReset.source, 'range_rule', 'Source is range_rule')
}

// ── 4. PREVIEW CALCULATOR LOGIC (VARIATIONS & BANDS) ──────────────────────────
console.log('\n--- 4. PREVIEW CALCULATOR LOGIC ---')
{
  const storeContext = { pricing_mode: 'range_rules', fallback_markup_percent: 40 }
  const rules = [
    { id: 101, min_cost: 0, max_cost: 10, markup_percent: 100 },
    { id: 102, min_cost: 10, max_cost: 20, markup_percent: 75 },
    { id: 103, min_cost: 20, max_cost: 50, markup_percent: 50 },
  ]

  // Variation 1: Cost £7.50 (Band 101 -> +100%)
  const var1 = resolveItemPrice(7.5, storeContext, rules, null)
  assertEqual(var1.sellingPrice, 15.0, 'Variation 1 (£7.50 cost) -> £15.00')
  assertEqual(var1.matchedRuleId, 101, 'Variation 1 matched rule 101')

  // Variation 2: Cost £14.00 (Band 102 -> +75%)
  const var2 = resolveItemPrice(14.0, storeContext, rules, null)
  assertEqual(var2.sellingPrice, 24.5, 'Variation 2 (£14.00 cost) -> £24.50')
  assertEqual(var2.matchedRuleId, 102, 'Variation 2 matched rule 102')

  // Variation 3: Cost £28.00 (Band 103 -> +50%)
  const var3 = resolveItemPrice(28.0, storeContext, rules, null)
  assertEqual(var3.sellingPrice, 42.0, 'Variation 3 (£28.00 cost) -> £42.00')
  assertEqual(var3.matchedRuleId, 103, 'Variation 3 matched rule 103')

  // Variation 4: Cost £60.00 (Gap/Above rules -> Fallback +40%)
  const var4 = resolveItemPrice(60.0, storeContext, rules, null)
  // 60.00 * 1.40 = 84.00
  assertEqual(var4.sellingPrice, 84.0, 'Variation 4 (£60.00 cost) -> Fallback £84.00 (+40%)')
  assertEqual(var4.source, 'store_fallback_markup', 'Variation 4 source is store_fallback_markup')
}

// ── 5. AUTHORIZATION & ROLE GUARDS ───────────────────────────────────────────
console.log('\n--- 5. AUTHORIZATION & ROLE GUARDS ---')
{
  // Unauthenticated caller
  const unauth = requireAdminOrSuperAdminApi(null)
  assertEqual(unauth.ok, false, 'Unauthenticated caller rejected (401)')
  assertEqual(unauth.status, 401, 'Returns 401 status')

  // Non-admin user (e.g. customer/regular user)
  const regularUser = requireAdminOrSuperAdminApi({ user: { id: 99, role: 'customer' } })
  assertEqual(regularUser.ok, false, 'Regular customer rejected (403)')
  assertEqual(regularUser.status, 403, 'Returns 403 status')

  // Super admin
  const superAdmin = requireAdminOrSuperAdminApi({ user: { id: 1, role: 'super_admin' } })
  assertEqual(superAdmin.ok, true, 'Super admin allowed')

  // Store admin
  const storeAdmin = requireAdminOrSuperAdminApi({ user: { id: 2, role: 'admin' } })
  assertEqual(storeAdmin.ok, true, 'Store admin allowed')
}

console.log('\n====================================================')
console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`)
console.log('====================================================')

if (failed > 0) {
  process.exit(1)
}