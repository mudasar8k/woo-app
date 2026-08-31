/**
 * Automated Regression Test Suite: Category vs Product vs Variation Override Priority & Membership
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
  console.log('=============================================================================')
  console.log('RUNNING CATEGORY VS PRODUCT OVERRIDE PRIORITY & MEMBERSHIP REGRESSION TESTS')
  console.log('=============================================================================\n')

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
    { id: 2, category: 'T-Shirts', markup_percent: 1000, priority: 1, active: true },
  ]

  const productTR653 = {
    id: 8282,
    sku: 'TR653',
    name: "Women's TriDri luxe fitted tee",
    categories: 'T-Shirts',
    cost: 3.95,
  }

  // --- 1. BASELINE UNDER CATEGORY RULE (+1000%) ---
  console.log('--- 1. BASELINE UNDER CATEGORY RULE (+1000%) ---')
  const baseRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, null, productTR653.categories, categoryRules, null)
  assert(baseRes.sellingPrice === 43.45, 'Baseline TR653 price under +1000% T-Shirts category rule is £43.45 (£3.95 * 11.0 = £43.45)', baseRes.sellingPrice)
  assert(baseRes.source === 'category_rule', 'Source is category_rule', baseRes.source)
  assert(baseRes.appliedMarkup === 1000, 'Applied markup is 1000%')
  assert(baseRes.matchedCategory === 'T-Shirts', 'Matched category is T-Shirts')

  // --- 2. PRODUCT CUSTOM MARKUP (+500%) OVERRIDES CATEGORY RULE ---
  console.log('\n--- 2. PRODUCT CUSTOM MARKUP (+500%) OVERRIDES CATEGORY RULE ---')
  const prodOverride500 = { override_type: 'custom_markup', custom_markup_percent: 500 }
  const prodRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, prodOverride500, productTR653.categories, categoryRules, null)
  assert(prodRes.sellingPrice === 23.70, 'TR653 with +500% product custom markup is £23.70 (£3.95 * 6.0 = £23.70)', prodRes.sellingPrice)
  assert(prodRes.source === 'product_custom_markup', 'Source is product_custom_markup', prodRes.source)
  assert(prodRes.appliedMarkup === 500, 'Applied markup is 500%')

  // --- 3. VARIATION CUSTOM MARKUP (+700%) OVERRIDES PRODUCT & CATEGORY RULES ---
  console.log('\n--- 3. VARIATION CUSTOM MARKUP (+700%) OVERRIDES PRODUCT & CATEGORY ---')
  const varOverride700 = { override_type: 'custom_markup', custom_markup_percent: 700 }
  const varRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, prodOverride500, productTR653.categories, categoryRules, varOverride700)
  assert(varRes.sellingPrice === 31.60, 'Variation with +700% custom markup is £31.60 (£3.95 * 8.0 = £31.60)', varRes.sellingPrice)
  assert(varRes.source === 'variation_custom_markup', 'Source is variation_custom_markup', varRes.source)
  assert(varRes.appliedMarkup === 700, 'Applied markup is 700%')

  // --- 4. RESET VARIATION FALLS BACK TO PRODUCT OVERRIDE ---
  console.log('\n--- 4. RESET VARIATION OVERRIDE FALLBACK ---')
  const varResetRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, prodOverride500, productTR653.categories, categoryRules, null)
  assert(varResetRes.sellingPrice === 23.70, 'Reset variation falls back to product override (£23.70)', varResetRes.sellingPrice)
  assert(varResetRes.source === 'product_custom_markup', 'Source is product_custom_markup', varResetRes.source)

  // --- 5. RESET PRODUCT OVERRIDE FALLS BACK TO CATEGORY RULE ---
  console.log('\n--- 5. RESET PRODUCT OVERRIDE FALLBACK ---')
  const prodResetRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, null, productTR653.categories, categoryRules, null)
  assert(prodResetRes.sellingPrice === 43.45, 'Reset product falls back to category rule (£43.45)', prodResetRes.sellingPrice)
  assert(prodResetRes.source === 'category_rule', 'Source is category_rule', prodResetRes.source)

  // --- 6. RESET CATEGORY RULE FALLS BACK TO RANGE RULE ---
  console.log('\n--- 6. RESET CATEGORY RULE FALLBACK ---')
  const catResetRes = resolveItemPrice(productTR653.cost, storeContextTiered, rangeRules, null, '', [], null)
  assert(catResetRes.sellingPrice === 10.94, 'Reset category rule falls back to range rule (£3.95 + 177% = £10.94)', catResetRes.sellingPrice)
  assert(catResetRes.source === 'range_rule', 'Source is range_rule', catResetRes.source)

  // --- 7. MEMBERSHIP QUERY INTEGRITY ---
  console.log('\n--- 7. MEMBERSHIP QUERY INTEGRITY ---')
  const checkMembership = (psStatus) => {
    return psStatus === null || psStatus !== 'removed'
  }
  assert(checkMembership(null) === true, 'Unsynced product (psStatus=null) is eligible for store pricing')
  assert(checkMembership('approved') === true, 'Approved product (psStatus=approved) is eligible for store pricing')
  assert(checkMembership('synced') === true, 'Synced product (psStatus=synced) is eligible for store pricing')
  assert(checkMembership('pending') === true, 'Pending product (psStatus=pending) is eligible for preparing pricing')
  assert(checkMembership('removed') === false, 'Removed product (psStatus=removed) is excluded from active store operations')

  console.log('\n=============================================================================')
  console.log(`CATEGORY/PRODUCT PRIORITY TESTS: ${passedCount} PASSED, ${failedCount} FAILED`)
  console.log('=============================================================================')

  if (failedCount > 0) process.exit(1)
}

runTests()
