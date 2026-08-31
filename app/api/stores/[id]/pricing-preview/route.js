export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import {
  resolveCostPrice,
  resolveItemPrice,
  loadStorePricingEngine,
  loadProductStoreOverrides,
  loadVariationStoreOverrides,
  loadProductVariationStoreOverrides,
  toNumber,
  round2,
} from '../../../../lib/pricing'

/**
 * POST /api/stores/[id]/pricing-preview
 *
 * Provides real-time preview of pricing calculations:
 * 1. Single cost calculation: { cost: 12.50, preview_mode?: 'range_rules', preview_rules?: [...], preview_fallback?: 40, categories?: 'T-Shirts' }
 * 2. Catalog sample preview: { preview_sample: true, limit?: 20, preview_rules?: [...], preview_fallback?: 40, preview_category_rules?: [...] }
 * 3. Specific product calculation: { product_id: 123 }
 */
export async function POST(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const storeId = parseInt(id, 10)

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    const body = await request.json().catch(() => ({}))

    // 1. Load active pricing context, saved range rules, and saved category rules from database
    const { storeContext, rangeRules: savedRangeRules, categoryRules: savedCategoryRules } =
      await loadStorePricingEngine(db, storeId)

    // ── Case A: Single Arbitrary Cost Preview (Live Calculator Widget) ────
    if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
      const rawCost = toNumber(body.cost)
      if (rawCost === null || rawCost < 0) {
        return NextResponse.json({ error: 'Invalid cost value' }, { status: 400 })
      }

      const rangeRulesToUse = Array.isArray(body.preview_rules) ? body.preview_rules : savedRangeRules
      const categoryRulesToUse = Array.isArray(body.preview_category_rules)
        ? body.preview_category_rules
        : savedCategoryRules

      const contextToUse = {
        ...storeContext,
        pricing_mode: body.preview_mode || storeContext.pricing_mode,
        fallback_markup_percent:
          body.preview_fallback !== undefined
            ? toNumber(body.preview_fallback)
            : storeContext.fallback_markup_percent,
      }

      const result = resolveItemPrice(
        rawCost,
        contextToUse,
        rangeRulesToUse,
        null,
        body.categories || body.category || null,
        categoryRulesToUse
      )

      return NextResponse.json({
        store_id: storeId,
        pricing_mode: contextToUse.pricing_mode,
        supplier_cost: result.cost,
        selling_price: result.sellingPrice,
        source: result.source,
        applied_markup: result.appliedMarkup,
        matched_rule_id: result.matchedRuleId,
        matched_category_rule_id: result.matchedCategoryRuleId || null,
        matched_category: result.matchedCategory || null,
      })
    }

    // ── Case B: Batch Catalog Impact Preview (20 Representative Items) ───
    if (body.preview_sample === true) {
      const sampleLimit = Math.min(parseInt(body.limit, 10) || 20, 50)
      const proposedRangeRules = Array.isArray(body.preview_rules) ? body.preview_rules : savedRangeRules
      const proposedCategoryRules = Array.isArray(body.preview_category_rules)
        ? body.preview_category_rules
        : savedCategoryRules

      const proposedContext = {
        ...storeContext,
        pricing_mode: body.preview_mode || 'range_rules',
        fallback_markup_percent:
          body.preview_fallback !== undefined
            ? toNumber(body.preview_fallback)
            : storeContext.fallback_markup_percent,
      }

      // Query distinct active/exportable products linked to this store
      const prodsRes = await db.query(
        `SELECT p.id, p.sku, p.name, p.categories, p.price, p.regular_price
         FROM products p
         JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
         WHERE ps.store_id = $1
           AND (ps.status IS NULL OR ps.status NOT IN ('removed', 'rejected'))
           AND (p.status IS NULL OR p.status != 'rejected')
         ORDER BY p.id ASC
         LIMIT $2`,
        [storeId, sampleLimit]
      )

      const productIds = prodsRes.rows.map((p) => p.id)
      let variationsByProduct = new Map()
      let overridesMap = new Map()
      let varOverridesMap = new Map()

      if (productIds.length > 0) {
        // Parallel batch fetch: variations + product pricing overrides + variation pricing overrides (Zero N+1 queries)
        const [varsRes, loadedOverrides] = await Promise.all([
          db.query(
            `SELECT id, product_id, sku, price, regular_price, size, color
             FROM product_variations
             WHERE product_id = ANY($1::int[])
             ORDER BY id ASC`,
            [productIds]
          ),
          loadProductStoreOverrides(db, storeId, productIds),
        ])

        const variationIds = varsRes.rows.map((v) => v.id)
        varOverridesMap = await loadVariationStoreOverrides(db, storeId, variationIds)

        for (const v of varsRes.rows) {
          if (!variationsByProduct.has(v.product_id)) {
            variationsByProduct.set(v.product_id, [])
          }
          variationsByProduct.get(v.product_id).push(v)
        }

        overridesMap = loadedOverrides
      }

      const comparisonItems = []

      for (const prod of prodsRes.rows) {
        const vars = variationsByProduct.get(prod.id) || []
        const override = overridesMap.get(prod.id) || null

        if (vars.length > 0) {
          // Select representative variation with valid supplier cost
          const repVar =
            vars.find((v) => resolveCostPrice(v) !== null && resolveCostPrice(v) > 0) || vars[0]
          const cost = resolveCostPrice(repVar)
          if (cost === null || cost <= 0) continue

          const varOverride = varOverridesMap.get(repVar.id) || null

          const currentRes = resolveItemPrice(
            cost,
            storeContext,
            savedRangeRules,
            override,
            prod.categories,
            savedCategoryRules,
            varOverride
          )

          const proposedRes = resolveItemPrice(
            cost,
            proposedContext,
            proposedRangeRules,
            override,
            prod.categories,
            proposedCategoryRules,
            varOverride
          )

          const currentPrice = currentRes.sellingPrice
          const proposedPrice = proposedRes.sellingPrice
          const diffAmount =
            currentPrice !== null && proposedPrice !== null ? round2(proposedPrice - currentPrice) : 0
          const diffPercent =
            currentPrice && currentPrice > 0 ? round2(((proposedPrice - currentPrice) / currentPrice) * 100) : 0

          comparisonItems.push({
            product_id: prod.id,
            name: prod.name,
            sku: repVar.sku || prod.sku,
            categories: prod.categories,
            is_variation: true,
            variation_attrs: [repVar.color, repVar.size].filter(Boolean).join(' / ') || null,
            supplier_cost: cost,
            current_price: currentPrice,
            current_source: currentRes.source,
            proposed_price: proposedPrice,
            proposed_source: proposedRes.source,
            applied_markup: proposedRes.appliedMarkup,
            matched_category: proposedRes.matchedCategory || null,
            diff_amount: diffAmount,
            diff_percent: diffPercent,
          })
        } else {
          // Simple product
          const cost = resolveCostPrice(prod)
          if (cost === null || cost <= 0) continue

          const currentRes = resolveItemPrice(
            cost,
            storeContext,
            savedRangeRules,
            override,
            prod.categories,
            savedCategoryRules
          )

          const proposedRes = resolveItemPrice(
            cost,
            proposedContext,
            proposedRangeRules,
            override,
            prod.categories,
            proposedCategoryRules
          )

          const currentPrice = currentRes.sellingPrice
          const proposedPrice = proposedRes.sellingPrice
          const diffAmount =
            currentPrice !== null && proposedPrice !== null ? round2(proposedPrice - currentPrice) : 0
          const diffPercent =
            currentPrice && currentPrice > 0 ? round2(((proposedPrice - currentPrice) / currentPrice) * 100) : 0

          comparisonItems.push({
            product_id: prod.id,
            name: prod.name,
            sku: prod.sku,
            categories: prod.categories,
            is_variation: false,
            variation_attrs: null,
            supplier_cost: cost,
            current_price: currentPrice,
            current_source: currentRes.source,
            proposed_price: proposedPrice,
            proposed_source: proposedRes.source,
            applied_markup: proposedRes.appliedMarkup,
            matched_category: proposedRes.matchedCategory || null,
            diff_amount: diffAmount,
            diff_percent: diffPercent,
          })
        }

        if (comparisonItems.length >= sampleLimit) break
      }

      return NextResponse.json({
        store_id: storeId,
        current_pricing_mode: storeContext.pricing_mode,
        current_markup_percent: storeContext.price_rule_percent,
        sample_count: comparisonItems.length,
        items: comparisonItems,
      })
    }

    // ── Case C: Single Product & Variations Calculation ──────────────────
    const productId = parseInt(body.product_id, 10)
    if (!productId || Number.isNaN(productId)) {
      return NextResponse.json(
        { error: 'Provide a numeric "cost", "product_id", or "preview_sample": true in the request body.' },
        { status: 400 }
      )
    }

    const prodRes = await db.query(
      `SELECT id, sku, name, price, regular_price, sale_price, categories
       FROM products
       WHERE id = $1`,
      [productId]
    )

    if (prodRes.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    const product = prodRes.rows[0]
    const [overridesMap, varOverridesMap, varRes] = await Promise.all([
      loadProductStoreOverrides(db, storeId, [productId]),
      loadProductVariationStoreOverrides(db, storeId, productId),
      db.query(
        `SELECT id, sku, price, regular_price, sale_price, size, color
         FROM product_variations
         WHERE product_id = $1
         ORDER BY id ASC`,
        [productId]
      ),
    ])
    const productOverride = overridesMap.get(productId) || null

    // Determine representative parent supplier cost:
    // 1. Direct parent price / regular_price
    // 2. Minimum variation cost across child variations (for variable products)
    let parentCost = resolveCostPrice(product)
    if ((parentCost === null || parentCost === 0) && varRes.rows.length > 0) {
      const validCosts = varRes.rows
        .map((v) => resolveCostPrice(v))
        .filter((c) => c !== null && c > 0)
      if (validCosts.length > 0) {
        parentCost = Math.min(...validCosts)
      }
    }

    const parentCalc = resolveItemPrice(
      parentCost,
      storeContext,
      savedRangeRules,
      productOverride,
      product.categories,
      savedCategoryRules
    )

    const variationsPreview = varRes.rows.map((v) => {
      const varCost = resolveCostPrice(v)
      const varOverride = varOverridesMap.get(v.id) || null
      const varCalc = resolveItemPrice(
        varCost,
        storeContext,
        savedRangeRules,
        productOverride,
        product.categories,
        savedCategoryRules,
        varOverride
      )
      return {
        id: v.id,
        sku: v.sku,
        size: v.size,
        color: v.color,
        supplier_cost: varCost,
        selling_price: varCalc.sellingPrice,
        source: varCalc.source,
        applied_markup: varCalc.appliedMarkup,
        matched_rule_id: varCalc.matchedRuleId,
        matched_category: varCalc.matchedCategory || null,
        override: varOverride || {
          override_type: 'product_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      }
    })

    return NextResponse.json({
      store_id: storeId,
      pricing_mode: storeContext.pricing_mode,
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        categories: product.categories,
        supplier_cost: parentCost,
        selling_price: parentCalc.sellingPrice,
        source: parentCalc.source,
        applied_markup: parentCalc.appliedMarkup,
        matched_rule_id: parentCalc.matchedRuleId,
        matched_category: parentCalc.matchedCategory || null,
        override: productOverride || {
          override_type: 'store_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      },
      variations: variationsPreview,
    })
  } catch (error) {
    console.error('Error calculating pricing preview:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
