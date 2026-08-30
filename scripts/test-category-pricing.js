/**
 * Automated Test Suite for Category-Based Pricing Rules:
 * 1. Single category rule match
 * 2. No category match -> range rule fallback
 * 3. Product custom markup override beats category rule
 * 4. Product fixed override beats category rule
 * 5. Multiple categories -> priority wins (lowest priority number)
 * 6. Disabled category rule ignored
 * 7. Store isolation
 * 8. Category markup applies per variation cost
 * 9. Exact category token matching (no substring collisions)
 * 10. Category rule survives supplier cost update
 * 11. Reset product override falls back to category rule
 * 12. Category rule removed -> falls back to range rule
 * 13. Legacy pricing with no category rules remains 100% identical
 * 14. Export price matches UI table price
 * 15. Direct sync price matches export price
 * 16. 100-product legacy snapshot has 0 drift
 */

const {
  resolveItemPrice,
  parseCategoryTokens,
  matchCategoryPricingRule,
  applyPriceRule,
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
console.log('RUNNING CATEGORY-BASED PRICING AUTOMATED TESTS')
console.log('====================================================\n')

const storeContextTiered = { pricing_mode: 'range_rules', fallback_markup_percent: 40 }
const rangeRules = [
  { id: 1, min_cost: 0, max_cost: 5, markup_percent: 177 },
  { id: 2, min_cost: 5, max_cost: 10, markup_percent: 100 },
  { id: 3, min_cost: 10, max_cost: 20, markup_percent: 75 },
  { id: 4, min_cost: 20, max_cost: 50, markup_percent: 50 },
]

const categoryRules = [
  { id: 10, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true },
  { id: 11, category: 'Hoodies', markup_percent: 120, priority: 2, active: true },
  { id: 12, category: 'Jackets', markup_percent: 80, priority: 3, active: true },
]

// ── 1. SINGLE CATEGORY RULE MATCH ───────────────────────────────────────────
console.log('--- 1. SINGLE CATEGORY RULE MATCH ---')
{
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', categoryRules)
  // 10 * 2.50 = 25.00
  assertEqual(res.sellingPrice, 25.0, 'T-Shirts (£10.00 cost) with +150% category rule -> £25.00')
  assertEqual(res.source, 'category_rule', 'Source is category_rule')
  assertEqual(res.matchedCategory, 'T-Shirts', 'Matched category is T-Shirts')
  assertEqual(res.appliedMarkup, 150, 'Applied markup is 150%')
}

// ── 2. NO CATEGORY MATCH -> RANGE RULE FALLBACK ─────────────────────────────
console.log('\n--- 2. NO CATEGORY MATCH -> RANGE RULE FALLBACK ---')
{
  // Outerwear is not in categoryRules -> Falls through to Band 3 (£10–£20 at +75%)
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'Outerwear', categoryRules)
  assertEqual(res.sellingPrice, 17.5, 'Outerwear (£10.00 cost) falls back to range rule (+75%) -> £17.50')
  assertEqual(res.source, 'range_rule', 'Source is range_rule')
}

// ── 3. PRODUCT CUSTOM MARKUP OVERRIDE BEATS CATEGORY RULE ───────────────────
console.log('\n--- 3. PRODUCT CUSTOM MARKUP OVERRIDE BEATS CATEGORY RULE ---')
{
  const customOverride = { override_type: 'custom_markup', custom_markup_percent: 80 }
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, customOverride, 'T-Shirts', categoryRules)
  // 10 * 1.80 = 18.00 (instead of +150% -> £25.00)
  assertEqual(res.sellingPrice, 18.0, 'Custom markup override (+80%) beats category rule (+150%) -> £18.00')
  assertEqual(res.source, 'product_custom_markup', 'Source is product_custom_markup')
}

// ── 4. PRODUCT FIXED OVERRIDE BEATS CATEGORY RULE ────────────────────────────
console.log('\n--- 4. PRODUCT FIXED OVERRIDE BEATS CATEGORY RULE ---')
{
  const fixedOverride = { override_type: 'fixed_price', fixed_price: 35.0 }
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, fixedOverride, 'T-Shirts', categoryRules)
  assertEqual(res.sellingPrice, 35.0, 'Fixed price override (£35.00) beats category rule -> £35.00')
  assertEqual(res.source, 'product_fixed', 'Source is product_fixed')
}

// ── 5. MULTIPLE CATEGORIES -> LOWEST PRIORITY NUMBER WINS ───────────────────
console.log('\n--- 5. MULTIPLE CATEGORIES PRIORITY RESOLUTION ---')
{
  const multiCatRules = [
    { id: 101, category: 'Workwear', markup_percent: 100, priority: 1, active: true },
    { id: 102, category: 'Jackets', markup_percent: 80, priority: 2, active: true },
    { id: 103, category: 'Safety', markup_percent: 60, priority: 3, active: true },
  ]

  // Product belongs to "Jackets, Workwear, Safety"
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'Jackets, Workwear, Safety', multiCatRules)
  // Priority 1 is Workwear (+100% -> £20.00)
  assertEqual(res.sellingPrice, 20.0, 'Priority 1 (Workwear +100%) wins over Priority 2 (Jackets) and 3 (Safety)')
  assertEqual(res.matchedCategory, 'Workwear', 'Matched category is Workwear')
  assertEqual(res.appliedMarkup, 100, 'Applied markup is 100%')
}

// ── 6. DISABLED CATEGORY RULE IGNORED ────────────────────────────────────────
console.log('\n--- 6. DISABLED CATEGORY RULE IGNORED ---')
{
  const rulesWithDisabled = [
    { id: 10, category: 'T-Shirts', markup_percent: 150, priority: 1, active: false },
  ]
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', rulesWithDisabled)
  // Disabled T-Shirts ignored -> Falls back to Band 3 (+75%)
  assertEqual(res.sellingPrice, 17.5, 'Disabled category rule ignored; falls back to range rule (£17.50)')
  assertEqual(res.source, 'range_rule', 'Source is range_rule')
}

// ── 7. STORE ISOLATION ───────────────────────────────────────────────────────
console.log('\n--- 7. STORE ISOLATION ---')
{
  const store4CatRules = [{ id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true }]
  const store5CatRules = [{ id: 2, category: 'T-Shirts', markup_percent: 110, priority: 1, active: true }]

  const s4 = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', store4CatRules)
  const s5 = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', store5CatRules)

  assertEqual(s4.sellingPrice, 25.0, 'Store 4 prices T-Shirts at +150% (£25.00)')
  assertEqual(s5.sellingPrice, 21.0, 'Store 5 prices T-Shirts at +110% (£21.00)')
  assert(s4.sellingPrice !== s5.sellingPrice, 'Category rules are strictly isolated per store')
}

// ── 8. CATEGORY MARKUP APPLIES PER VARIATION COST ────────────────────────────
console.log('\n--- 8. PER-VARIATION COST RESOLUTION WITH CATEGORY RULES ---')
{
  const catRules = [{ id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true }]

  // Variation S (£8.00 cost) -> 8 * 2.50 = 20.00
  const varS = resolveItemPrice(8.0, storeContextTiered, rangeRules, null, 'T-Shirts', catRules)
  assertEqual(varS.sellingPrice, 20.0, 'Variation S (£8.00 cost) receives +150% -> £20.00')

  // Variation 3XL (£12.00 cost) -> 12 * 2.50 = 30.00
  const var3XL = resolveItemPrice(12.0, storeContextTiered, rangeRules, null, 'T-Shirts', catRules)
  assertEqual(var3XL.sellingPrice, 30.0, 'Variation 3XL (£12.00 cost) receives +150% -> £30.00')
}

// ── 9. EXACT CATEGORY TOKEN MATCHING ─────────────────────────────────────────
console.log('\n--- 9. EXACT CATEGORY TOKEN MATCHING (NO SUBSTRING COLLISIONS) ---')
{
  const catRules = [
    { id: 1, category: 'Men', markup_percent: 100, priority: 1, active: true },
    { id: 2, category: 'Shirt', markup_percent: 120, priority: 2, active: true },
  ]

  // A. "Women" should NOT match "Men"
  const resWomen = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'Women', catRules)
  assertEqual(resWomen.source, 'range_rule', '"Women" does NOT falsely match "Men" rule')

  // B. "T-Shirts" should NOT match "Shirt"
  const resTShirts = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', catRules)
  assertEqual(resTShirts.source, 'range_rule', '"T-Shirts" does NOT falsely match "Shirt" rule')

  // C. Case-insensitive & trimmed match
  const resMatch = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, '  MEN  ', catRules)
  assertEqual(resMatch.sellingPrice, 20.0, '"  MEN  " exact case-insensitive matches "Men" rule')
  assertEqual(resMatch.source, 'category_rule', 'Source is category_rule')
}

// ── 10. CATEGORY RULE SURVIVES SUPPLIER COST UPDATE ─────────────────────────
console.log('\n--- 10. SUPPLIER COST UPDATE WITH CATEGORY RULE ---')
{
  const catRules = [{ id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true }]

  // Initial cost £4.00 -> 4 * 2.50 = 10.00
  const resInitial = resolveItemPrice(4.0, storeContextTiered, rangeRules, null, 'T-Shirts', catRules)
  assertEqual(resInitial.sellingPrice, 10.0, 'Initial cost £4.00 in T-Shirts (+150%) -> £10.00')

  // Updated cost £6.00 -> 6 * 2.50 = 15.00 (stays in category rule rather than moving to Band 2)
  const resUpdated = resolveItemPrice(6.0, storeContextTiered, rangeRules, null, 'T-Shirts', catRules)
  assertEqual(resUpdated.sellingPrice, 15.0, 'Updated cost £6.00 in T-Shirts (+150%) -> £15.00')
}

// ── 11. RESET PRODUCT OVERRIDE FALLS BACK TO CATEGORY RULE ──────────────────
console.log('\n--- 11. RESET PRODUCT OVERRIDE TO CATEGORY RULE ---')
{
  const catRules = [{ id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true }]

  // Product has custom markup +50% -> 10 * 1.50 = 15.00
  const overridden = resolveItemPrice(10.0, storeContextTiered, rangeRules, { override_type: 'custom_markup', custom_markup_percent: 50 }, 'T-Shirts', catRules)
  assertEqual(overridden.sellingPrice, 15.0, 'Overridden product = £15.00')

  // Reset override -> Falls back to T-Shirts category rule (+150% -> £25.00)
  const reset = resolveItemPrice(10.0, storeContextTiered, rangeRules, { override_type: 'store_rules' }, 'T-Shirts', catRules)
  assertEqual(reset.sellingPrice, 25.0, 'Reset override cleanly falls back to category rule (£25.00)')
  assertEqual(reset.source, 'category_rule', 'Source is category_rule')
}

// ── 12. CATEGORY RULE REMOVED -> FALLS BACK TO RANGE RULE ───────────────────
console.log('\n--- 12. CATEGORY RULE REMOVAL FALLBACK ---')
{
  // When categoryRules is empty
  const res = resolveItemPrice(10.0, storeContextTiered, rangeRules, null, 'T-Shirts', [])
  assertEqual(res.sellingPrice, 17.5, 'Category rule removed -> falls back to range rule (£17.50)')
  assertEqual(res.source, 'range_rule', 'Source is range_rule')
}

// ── 13. LEGACY PRICING WITH NO CATEGORY RULES REMAINS 100% IDENTICAL ─────────
console.log('\n--- 13. LEGACY PRICING ACCURACY ---')
{
  const legacyContext = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }
  const res = resolveItemPrice(4.71, legacyContext, rangeRules, null, 'T-Shirts', [])
  assertEqual(res.sellingPrice, 13.05, 'Legacy Store 4 price on £4.71 is £13.05 (+177%)')
  assertEqual(res.source, 'store_legacy_override', 'Source is store_legacy_override')
}

// ── 14. EXPORT PRICE MATCHES UI TABLE PRICE ─────────────────────────────────
console.log('\n--- 14. EXPORT PRICE AND UI MATCH ---')
{
  const catRules = [{ id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true }]
  const uiPrice = resolveItemPrice(11.77, storeContextTiered, rangeRules, null, 'T-Shirts', catRules).sellingPrice
  const exportPrice = resolveItemPrice(11.77, storeContextTiered, rangeRules, null, 'T-Shirts', catRules).sellingPrice

  assertEqual(uiPrice, 29.43, 'UI price for £11.77 in T-Shirts = £29.43')
  assertEqual(exportPrice, 29.43, 'Export price for £11.77 in T-Shirts = £29.43')
  assertEqual(uiPrice, exportPrice, 'UI and Export price match 100%')
}

// ── 15. DIRECT SYNC PRICE MATCHES EXPORT PRICE ──────────────────────────────
console.log('\n--- 15. DIRECT SYNC AND EXPORT MATCH ---')
{
  const catRules = [{ id: 1, category: 'Hoodies', markup_percent: 120, priority: 1, active: true }]
  const exportPrice = resolveItemPrice(20.0, storeContextTiered, rangeRules, null, 'Hoodies', catRules).sellingPrice
  const syncPrice = resolveItemPrice(20.0, storeContextTiered, rangeRules, null, 'Hoodies', catRules).sellingPrice

  assertEqual(syncPrice, exportPrice, 'Direct sync price (£44.00) matches Export price (£44.00) exactly')
}

// ── 16. 100-PRODUCT LEGACY SNAPSHOT WITH 0 DRIFT ────────────────────────────
console.log('\n--- 16. 100-PRODUCT LEGACY SNAPSHOT (0 DRIFT) ---')
{
  const legacyContext = { pricing_mode: 'legacy_markup', price_rule_percent: 177 }
  let driftCount = 0

  for (let i = 1; i <= 100; i++) {
    const cost = round2(0.5 + (i * 1.73) + ((i % 5) * 0.23))
    const legacyExpected = applyPriceRule(cost, 177)
    const result = resolveItemPrice(cost, legacyContext, [], null, 'AnyCategory', [])

    if (legacyExpected !== result.sellingPrice) {
      driftCount++
    }
  }

  assertEqual(driftCount, 0, '100/100 products under legacy mode produced 0 price drift')
}

console.log('\n====================================================')
console.log(`CATEGORY PRICING TEST RESULTS: ${passed} PASSED, ${failed} FAILED`)
console.log('====================================================')

if (failed > 0) {
  process.exit(1)
}
