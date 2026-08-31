/**
 * Automated Regression Test Suite: Modal Current Selling Price & Parent Cost Resolution
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
  console.log('=================================================================')
  console.log('RUNNING MODAL CURRENT SELLING PRICE & PARENT RESOLUTION TESTS')
  console.log('=================================================================\n')

  const storeContextTiered = {
    id: 4,
    pricing_mode: 'range_rules',
    price_rule_percent: 177,
    fallback_markup_percent: null,
  }

  const rangeRules = [
    { id: 19, min_cost: 0, max_cost: 5, markup_percent: 177, active: true },
    { id: 20, min_cost: 5, max_cost: 10, markup_percent: 100, active: true },
    { id: 21, min_cost: 10, max_cost: 20, markup_percent: 75, active: true },
    { id: 22, min_cost: 20, max_cost: 50, markup_percent: 50, active: true },
    { id: 23, min_cost: 50, max_cost: null, markup_percent: 35, active: true },
  ]

  const categoryRules = []

  // Sample Product: TR801 (Variable product, parent price=null, child variations cost=34.95)
  const productTR801 = {
    id: 8848,
    sku: 'TR801',
    name: 'TriDri® Recycled all-seasons waterproof longline robe',
    price: null,
    regular_price: null,
    min_cost_price: 34.95,
    categories: 'Robes',
  }

  const variationsTR801 = [
    { id: 1, sku: 'TR801BLACSM', price: null, regular_price: '34.95' },
    { id: 2, sku: 'TR801BLACLXL', price: null, regular_price: '34.95' },
  ]

  // --- 1. REPRESENTATIVE PARENT COST RESOLUTION ---
  console.log('--- 1. REPRESENTATIVE PARENT COST RESOLUTION ---')
  let parentCostTR801 = resolveCostPrice(productTR801)
  if ((parentCostTR801 === null || parentCostTR801 === 0) && variationsTR801.length > 0) {
    const validCosts = variationsTR801
      .map((v) => resolveCostPrice(v))
      .filter((c) => c !== null && c > 0)
    if (validCosts.length > 0) {
      parentCostTR801 = Math.min(...validCosts)
    }
  }

  assert(parentCostTR801 === 34.95, 'Representative parent cost resolved to £34.95 from child variations', parentCostTR801)

  // --- 2. CURRENT SELLING PRICE RESOLUTION UNDER TIERED RULES ---
  console.log('\n--- 2. CURRENT SELLING PRICE RESOLUTION ---')
  const currentTR801 = resolveItemPrice(
    parentCostTR801,
    storeContextTiered,
    rangeRules,
    null,
    productTR801.categories,
    categoryRules
  )

  assert(currentTR801.sellingPrice === 52.43, 'Current Selling Price resolves to £52.43 (£34.95 + 50% band)', currentTR801.sellingPrice)
  assert(currentTR801.source === 'range_rule', 'Current Source is range_rule', currentTR801.source)
  assert(currentTR801.appliedMarkup === 50, 'Applied markup is 50%')

  // --- 3. MODAL PROPOSED PRICE & DIFF CALCULATION (+400% CUSTOM MARKUP) ---
  console.log('\n--- 3. MODAL PROPOSED PRICE & DIFF CALCULATION ---')
  const customMarkup = 400
  const proposedSellingPrice = round2(parentCostTR801 * (1 + customMarkup / 100))
  assert(proposedSellingPrice === 174.75, 'Proposed Selling Price is £174.75 (£34.95 * 5 = £174.75)', proposedSellingPrice)

  const diffAmount = round2(proposedSellingPrice - currentTR801.sellingPrice)
  const diffPercent = round2(((proposedSellingPrice - currentTR801.sellingPrice) / currentTR801.sellingPrice) * 100)

  assert(diffAmount === 122.32, 'Diff amount is +£122.32 (not £0.00 or NaN)', diffAmount)
  assert(diffPercent === 233.3, 'Diff percent is +233.3%', diffPercent)

  // --- 4. ZERO MARKUP / COST PRICE FALLBACK ---
  console.log('\n--- 4. ZERO MARKUP / COST PRICE FALLBACK ---')
  const storeContextNoRules = {
    id: 99,
    pricing_mode: 'legacy_markup',
    price_rule_percent: null,
    fallback_markup_percent: null,
    defaultPercent: null,
  }

  const costFallbackRes = resolveItemPrice(parentCostTR801, storeContextNoRules, [], null, productTR801.categories, [])
  assert(costFallbackRes.sellingPrice === 34.95, 'Cost Price fallback returns £34.95, never null or "-"', costFallbackRes.sellingPrice)
  assert(costFallbackRes.source === 'cost_price', 'Source is cost_price', costFallbackRes.source)

  // --- 5. SIMPLE PRODUCT DIRECT COST RESOLUTION ---
  console.log('\n--- 5. SIMPLE PRODUCT DIRECT COST RESOLUTION ---')
  const simpleProd = { id: 999, sku: 'SMP01', price: '10.00', regular_price: '10.00', categories: 'General' }
  const simpleCost = resolveCostPrice(simpleProd)
  const simpleRes = resolveItemPrice(simpleCost, storeContextTiered, rangeRules, null, simpleProd.categories, [])
  assert(simpleRes.sellingPrice === 20.00, 'Simple product (£10.00 cost) resolves to £20.00 (+100% band)', simpleRes.sellingPrice)
  assert(simpleRes.source === 'range_rule', 'Source is range_rule', simpleRes.source)

  console.log('\n=================================================================')
  console.log(`MODAL CURRENT PRICE TESTS: ${passedCount} PASSED, ${failedCount} FAILED`)
  console.log('=================================================================')

  if (failedCount > 0) process.exit(1)
}

runTests()
