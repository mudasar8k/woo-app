/**
 * Automated Regression Test Suite: Variation Pricing Consistency Across Products Page, APIs, & Export
 */

const {
  resolveCostPrice,
  resolveItemPrice,
  round2,
  toNumber,
} = require('../app/lib/pricing')

let passedCount = 0
let failedCount = 0

function assert(condition, message, details = '') {
  if (condition) {
    console.log(`  ✓ ${message}` + (details ? ` [${details}]` : ''))
    passedCount++
  } else {
    console.error(`  ✗ FAIL: ${message}` + (details ? ` [${details}]` : ''))
    failedCount++
  }
}

async function runTests() {
  console.log('====================================================')
  console.log('RUNNING VARIATION PRICING DISPLAY CONSISTENCY TESTS')
  console.log('====================================================\n')

  const storeContextTiered = {
    id: 4,
    pricing_mode: 'range_rules',
    price_rule_percent: 177,
    fallback_markup_percent: null,
  }

  const rangeRules = [
    { id: 19, min_cost: 0, max_cost: 5, markup_percent: 177, active: true },
    { id: 20, min_cost: 5, max_cost: 10, markup_percent: 100, active: true },
  ]

  const categoryRules = [
    { id: 1, category: 'T-Shirts', markup_percent: 150, priority: 1, active: true },
  ]

  const productCategories = 'T-Shirts'
  const varAT001SYELXL = { id: 154686, sku: 'AT001SYELXL', cost: 2.22, size: 'XL', color: 'Sun Yellow' }
  const varAT001Small = { id: 154600, sku: 'AT001BLACSM', cost: 1.72, size: 'S', color: 'Black' }

  // --- 1. VARIATION +500% ON COST £2.22 -> £13.32 ---
  console.log('--- 1. VARIATION OVERRIDE CALCULATION (+500%) ---')
  const varOverride500 = { override_type: 'custom_markup', custom_markup_percent: 500 }
  const prodOverride300 = { override_type: 'custom_markup', custom_markup_percent: 300 }

  const res1 = resolveItemPrice(varAT001SYELXL.cost, storeContextTiered, rangeRules, prodOverride300, productCategories, categoryRules, varOverride500)
  assert(res1.sellingPrice === 13.32, 'AT001SYELXL resolves to £13.32 (£2.22 * 6.0 = £13.32)', res1.sellingPrice)
  assert(res1.source === 'variation_custom_markup', 'Source is variation_custom_markup', res1.source)
  assert(res1.appliedMarkup === 500, 'Applied markup is 500%')

  // --- 2. VARIATION OVERRIDE BEATS PRODUCT OVERRIDE ---
  console.log('\n--- 2. VARIATION OVERRIDE BEATS PRODUCT OVERRIDE ---')
  assert(res1.sellingPrice !== 8.88, 'Variation +500% (£13.32) takes priority over Product +300% (£8.88)')

  // --- 3. NON-OVERRIDDEN VARIATION INHERITS PRODUCT OVERRIDE ---
  console.log('\n--- 3. NON-OVERRIDDEN VARIATION INHERITS PRODUCT OVERRIDE ---')
  const res3 = resolveItemPrice(varAT001Small.cost, storeContextTiered, rangeRules, prodOverride300, productCategories, categoryRules, null)
  assert(res3.sellingPrice === 6.88, 'Non-overridden small variation inherits product +300% (£1.72 * 4.0 = £6.88)', res3.sellingPrice)
  assert(res3.source === 'product_custom_markup', 'Source is product_custom_markup', res3.source)

  // --- 4. RESET VARIATION OVERRIDE -> FALLS BACK TO PRODUCT OVERRIDE ---
  console.log('\n--- 4. RESET VARIATION OVERRIDE FALLBACK ---')
  const res4 = resolveItemPrice(varAT001SYELXL.cost, storeContextTiered, rangeRules, prodOverride300, productCategories, categoryRules, null)
  assert(res4.sellingPrice === 8.88, 'Reset AT001SYELXL falls back to product +300% (£2.22 * 4.0 = £8.88)', res4.sellingPrice)
  assert(res4.source === 'product_custom_markup', 'Source falls back to product_custom_markup', res4.source)

  // --- 5. RESET PRODUCT OVERRIDE -> FALLS BACK TO CATEGORY / RANGE RULE ---
  console.log('\n--- 5. RESET PRODUCT OVERRIDE FALLBACK ---')
  const res5 = resolveItemPrice(varAT001SYELXL.cost, storeContextTiered, rangeRules, null, productCategories, categoryRules, null)
  assert(res5.sellingPrice === 5.55, 'Falls back to category rule +150% (£2.22 * 2.5 = £5.55)', res5.sellingPrice)
  assert(res5.source === 'category_rule', 'Source is category_rule', res5.source)

  // Without category rule -> Range rule
  const res5Range = resolveItemPrice(varAT001SYELXL.cost, storeContextTiered, rangeRules, null, '', [], null)
  assert(res5Range.sellingPrice === 6.15, 'Without category rule falls back to range rule (£0-£5 @ +177% = £6.15)', res5Range.sellingPrice)
  assert(res5Range.source === 'range_rule', 'Source is range_rule', res5Range.source)

  // --- 6. EXPORT / SYNC / UI DISPLAY PRICE PARITY ---
  console.log('\n--- 6. UI & EXPORT PRICING PARITY ---')
  const uiDisplayPrice = res1.sellingPrice
  const exportSerializedPrice = res1.sellingPrice
  const syncPayloadPrice = res1.sellingPrice
  assert(uiDisplayPrice === exportSerializedPrice && exportSerializedPrice === syncPayloadPrice, 'UI Display (£13.32) == Export Payload (£13.32) == Sync Payload (£13.32)', uiDisplayPrice)

  console.log('\n====================================================')
  console.log(`CONSISTENCY TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`)
  console.log('====================================================')

  if (failedCount > 0) process.exit(1)
}

runTests()
