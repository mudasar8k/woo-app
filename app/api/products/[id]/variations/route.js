export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  resolveCostPrice,
  resolveItemPrice,
  loadStorePricingEngine,
  loadProductStoreOverrides,
  loadProductVariationStoreOverrides,
} from '../../../../lib/pricing'

export async function GET(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const productId = parseInt(id, 10)
    const { searchParams } = new URL(request.url)
    const storeIdParam = searchParams.get('store_id')
    const storeId = storeIdParam ? parseInt(storeIdParam, 10) : null

    // Verify product exists
    const productCheck = await db.query(
      'SELECT id, sku, name, categories, price, regular_price, sale_price FROM products WHERE id = $1',
      [productId]
    )

    if (productCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }
    const product = productCheck.rows[0]

    // Check store access if store_id is provided
    if (storeId && session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )

      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    // Parallel fetch: variations + store pricing engine context + overrides (0 N+1 overhead)
    const [
      variationsResult,
      pricingEngine,
      productOverridesMap,
      varOverridesMap,
    ] = await Promise.all([
      db.query(
        `SELECT id, product_id, sku, attributes, size, color, price, regular_price, sale_price,
                stock_quantity, stock_status, tax_class, image, images, status
         FROM product_variations
         WHERE product_id = $1
         ORDER BY id ASC`,
        [productId]
      ),
      storeId ? loadStorePricingEngine(db, storeId) : Promise.resolve(null),
      storeId ? loadProductStoreOverrides(db, storeId, [productId]) : Promise.resolve(new Map()),
      storeId ? loadProductVariationStoreOverrides(db, storeId, productId) : Promise.resolve(new Map()),
    ])

    const productOverride = productOverridesMap.get(productId) || null

    const resolvedVariations = variationsResult.rows.map((variation) => {
      const cost = resolveCostPrice(variation)
      let storePrice = null
      let priceSource = 'cost_price'
      let appliedMarkup = null
      let matchedCategory = null
      let matchedRuleId = null
      let override = null

      if (pricingEngine) {
        const varOverride = varOverridesMap.get(variation.id) || null
        override = varOverride || {
          override_type: 'product_rules',
          custom_markup_percent: null,
          fixed_price: null,
        }

        const calc = resolveItemPrice(
          cost,
          pricingEngine.storeContext,
          pricingEngine.rangeRules,
          productOverride,
          product.categories,
          pricingEngine.categoryRules,
          varOverride
        )

        storePrice = calc.sellingPrice
        priceSource = calc.source
        appliedMarkup = calc.appliedMarkup
        matchedCategory = calc.matchedCategory
        matchedRuleId = calc.matchedRuleId
      }

      return {
        ...variation,
        supplier_cost: cost,
        store_price: storePrice,
        price_source: priceSource,
        applied_markup: appliedMarkup,
        matched_category: matchedCategory,
        matched_rule_id: matchedRuleId,
        override,
      }
    })

    return NextResponse.json({
      success: true,
      product_id: productId,
      store_id: storeId,
      variations: resolvedVariations,
    })
  } catch (error) {
    console.error('Error fetching variations:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch variations' },
      { status: 500 }
    )
  }
}
