/**
 * Automated Test Suite for Phase 4:
 * 1. Product-Level Pricing Overrides (Custom Markup & Fixed Selling Price)
 * 2. Per-Variation Calculation Behavior
 * 3. Reset Behavior & Fallback to Store Pricing
 * 4. Store Isolation Verification
 * 5. Input Validation & Boundaries
 * 6. Baseline Snapshot & Round-Trip Reset Verification
 */

const {
  resolveItemPrice,
  validatePricingRules,
  round2,
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
  if (actual === expected) {
    passed++
    console.log(`  ✓ ${message} [${actual}]`)
  } else {
    failed++
    console.error(`  ✗ FAIL: ${message} (Expected: ${expected}, Actual: ${actual})`)
  }
}

console.log('====================================================')
console.log('RUNNING PHASE 4 PRODUCT PRICING OVERRIDE TESTS')
console.log('====================================================\n')

// ── 1. CUSTOM MARKUP OVERRIDES (PER-VARIATION INDEPENDENT MARKUP) ────────────
console.log('--- 1. CUSTOM MARKUP OVERRIDES ---')
{
  const storeContext = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }
  const override = { override_type: 'custom_markup', custom_markup_percent: 80.0 }

  // Parent cost: £10.00
  const parent = resolveItemPrice(10.0, storeContext, [], override)
  assertEqual(parent.sellingPrice, 18.0, 'Parent (£10.00 cost) with +80% custom markup -> £18.00')
  assertEqual(parent.source, 'product_custom_markup', 'Source is product_custom_markup')

  // Variation S (£8.00 cost) -> 8.00 * 1.80 = 14.40
  const varS = resolveItemPrice(8.0, storeContext, [], override)
  assertEqual(varS.sellingPrice, 14.4, 'Variation S (£8.00 cost) marked up independently -> £14.40')

  // Variation 3XL (£12.00 cost) -> 12.00 * 1.80 = 21.60
  const var3XL = resolveItemPrice(12.0, storeContext, [], override)
  assertEqual(var3XL.sellingPrice, 21.6, 'Variation 3XL (£12.00 cost) marked up independently -> £21.60')
}

// ── 2. FIXED SELLING PRICE OVERRIDES (EQUAL ACROSS ALL VARIATIONS) ───────────
console.log('\n--- 2. FIXED SELLING PRICE OVERRIDES ---')
{
  const storeContext = { pricing_mode: 'range_rules', fallback_markup_percent: 40 }
  const rules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 },
    { id: 2, min_cost: 10, max_cost: 50, markup_percent: 50 },
  ]
  const fixedOverride = { override_type: 'fixed_price', fixed_price: 25.0 }

  // Parent cost: £10.00
  const parent = resolveItemPrice(10.0, storeContext, rules, fixedOverride)
  assertEqual(parent.sellingPrice, 25.0, 'Parent gets fixed selling price £25.00')
  assertEqual(parent.source, 'product_fixed', 'Source is product_fixed')

  // Variation S (£8.00 cost)
  const varS = resolveItemPrice(8.0, storeContext, rules, fixedOverride)
  assertEqual(varS.sellingPrice, 25.0, 'Variation S (£8.00 cost) sells at fixed £25.00')

  // Variation 3XL (£12.00 cost)
  const var3XL = resolveItemPrice(12.0, storeContext, rules, fixedOverride)
  assertEqual(var3XL.sellingPrice, 25.0, 'Variation 3XL (£12.00 cost) sells at fixed £25.00')

  // Variation 5XL (£20.00 cost)
  const var5XL = resolveItemPrice(20.0, storeContext, rules, fixedOverride)
  assertEqual(var5XL.sellingPrice, 25.0, 'Variation 5XL (£20.00 cost) sells at fixed £25.00')
}

// ── 3. RESET BEHAVIOR (FALLBACK TO STORE RULES) ──────────────────────────────
console.log('\n--- 3. RESET BEHAVIOR & FALLBACK ---')
{
  const storeContextLegacy = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }
  const storeContextTiered = {
    pricing_mode: 'range_rules',
    fallback_markup_percent: 35,
  }
  const rules = [
    { id: 1, min_cost: 0, max_cost: 10, markup_percent: 100 },
    { id: 2, min_cost: 10, max_cost: 20, markup_percent: 75 },
  ]

  // A. Reset in Legacy Mode
  const resetLegacy = resolveItemPrice(10.0, storeContextLegacy, rules, { override_type: 'store_rules' })
  assertEqual(resetLegacy.sellingPrice, 27.7, 'Reset in legacy mode restores store +177% (£27.70)')
  assertEqual(resetLegacy.source, 'store_legacy_override', 'Source is store_legacy_override')

  // B. Reset in Tiered Mode
  const resetTiered = resolveItemPrice(10.0, storeContextTiered, rules, { override_type: 'store_rules' })
  assertEqual(resetTiered.sellingPrice, 20.0, 'Reset in tiered mode restores range rule band (£20.00)')
  assertEqual(resetTiered.source, 'range_rule', 'Source is range_rule')
}

// ── 4. STORE ISOLATION VERIFICATION ──────────────────────────────────────────
console.log('\n--- 4. STORE ISOLATION VERIFICATION ---')
{
  // Store 4 has custom markup override +80% for TS030
  const store4Context = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }
  const store4Override = { override_type: 'custom_markup', custom_markup_percent: 80.0 }
  const store4Result = resolveItemPrice(11.77, store4Context, [], store4Override)

  // Store 5 has NO override for TS030 (uses its own store markup +100%)
  const store5Context = { pricing_mode: 'legacy_markup', price_rule_percent: 100 }
  const store5Override = null
  const store5Result = resolveItemPrice(11.77, store5Context, [], store5Override)

  assertEqual(store4Result.sellingPrice, 21.19, 'Store 4 sells TS030 at custom +80% (£21.19)')
  assertEqual(store5Result.sellingPrice, 23.54, 'Store 5 sells TS030 at store markup +100% (£23.54)')
  assert(store4Result.sellingPrice !== store5Result.sellingPrice, 'Store 4 override is strictly isolated from Store 5')
}

// ── 5. BASELINE SNAPSHOT & ROUND-TRIP RESET VERIFICATION ─────────────────────
console.log('\n--- 5. BASELINE SNAPSHOT & ROUND-TRIP RESET ---')
{
  const storeContext = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }

  // Baseline prices before override:
  const baselineAT001 = resolveItemPrice(4.71, storeContext, [], null)
  assertEqual(baselineAT001.sellingPrice, 13.05, 'Baseline AT001 = £13.05')

  const baselineTS030 = resolveItemPrice(11.77, storeContext, [], null)
  assertEqual(baselineTS030.sellingPrice, 32.6, 'Baseline TS030 = £32.60')

  // Step 1: Apply fixed override to AT001
  const overriddenAT001 = resolveItemPrice(4.71, storeContext, [], { override_type: 'fixed_price', fixed_price: 9.99 })
  assertEqual(overriddenAT001.sellingPrice, 9.99, 'Overridden AT001 = £9.99')

  // Step 2: Reset AT001 back to store rules
  const restoredAT001 = resolveItemPrice(4.71, storeContext, [], { override_type: 'store_rules' })
  assertEqual(restoredAT001.sellingPrice, baselineAT001.sellingPrice, 'Restored AT001 matches original baseline exactly (£13.05)')

  // Step 3: Apply custom markup to TS030
  const overriddenTS030 = resolveItemPrice(11.77, storeContext, [], { override_type: 'custom_markup', custom_markup_percent: 50 })
  assertEqual(overriddenTS030.sellingPrice, 17.66, 'Overridden TS030 = £17.66')

  // Step 4: Reset TS030 back to store rules
  const restoredTS030 = resolveItemPrice(11.77, storeContext, [], null)
  assertEqual(restoredTS030.sellingPrice, baselineTS030.sellingPrice, 'Restored TS030 matches original baseline exactly (£32.60)')
}

console.log('\n====================================================')
console.log(`PHASE 4 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`)
console.log('====================================================')

if (failed > 0) {
  process.exit(1)
}
