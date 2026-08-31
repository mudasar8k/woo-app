export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '@/app/lib/db'
import { auth } from '@/app/api/auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '@/app/lib/role-guards'
import {
  resolveCostPrice,
  resolveItemPrice,
  loadStorePricingEngine,
  loadProductStoreOverrides,
  toNumber,
} from '@/app/lib/pricing'

/**
 * GET /api/products/[id]/variations/[variationId]/store-pricing?store_id=4
 * Returns pricing context and active override for a single variation.
 */
export async function GET(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id, variationId: varIdParam } = await params
    const productId = parseInt(id, 10)
    const variationId = parseInt(varIdParam, 10)

    const { searchParams } = new URL(request.url)
    const storeIdParam = searchParams.get('store_id')
    if (!storeIdParam) {
      return NextResponse.json({ error: 'Missing required query parameter: store_id' }, { status: 400 })
    }
    const storeId = parseInt(storeIdParam, 10)

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    // Verify product belongs to store
    const prodCheck = await db.query(
      `SELECT p.id, p.name, p.sku, p.categories
       FROM products p
       LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $2
       WHERE p.id = $1 AND (ps.status IS NULL OR ps.status != 'removed')`,
      [productId, storeId]
    )
    if (prodCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found or not mapped to this store' }, { status: 404 })
    }
    const product = prodCheck.rows[0]

    // Verify variation belongs to product
    const varRes = await db.query(
      `SELECT id, product_id, sku, price, regular_price, sale_price, size, color
       FROM product_variations
       WHERE id = $1 AND product_id = $2`,
      [variationId, productId]
    )
    if (varRes.rows.length === 0) {
      return NextResponse.json({ error: 'Variation not found for this product' }, { status: 404 })
    }
    const variation = varRes.rows[0]

    // Load store pricing engine, product override, and variation override
    const [
      { storeContext, rangeRules, categoryRules },
      productOverridesMap,
      varOverrideRes,
    ] = await Promise.all([
      loadStorePricingEngine(db, storeId),
      loadProductStoreOverrides(db, storeId, [productId]),
      db.query(
        `SELECT override_type, custom_markup_percent, fixed_price, updated_at
         FROM variation_store_pricing
         WHERE store_id = $1 AND variation_id = $2 LIMIT 1`,
        [storeId, variationId]
      ),
    ])

    const productOverride = productOverridesMap.get(productId) || null
    let varOverride = null
    if (varOverrideRes.rows.length > 0) {
      const r = varOverrideRes.rows[0]
      varOverride = {
        override_type: r.override_type,
        custom_markup_percent: r.custom_markup_percent !== null ? Number(r.custom_markup_percent) : null,
        fixed_price: r.fixed_price !== null ? Number(r.fixed_price) : null,
        updated_at: r.updated_at,
      }
    }

    const cost = resolveCostPrice(variation)
    const calc = resolveItemPrice(
      cost,
      storeContext,
      rangeRules,
      productOverride,
      product.categories,
      categoryRules,
      varOverride
    )

    return NextResponse.json({
      store_id: storeId,
      product_id: productId,
      variation_id: variationId,
      sku: variation.sku,
      size: variation.size,
      color: variation.color,
      supplier_cost: cost,
      selling_price: calc.sellingPrice,
      source: calc.source,
      applied_markup: calc.appliedMarkup,
      override: varOverride || {
        override_type: 'product_rules',
        custom_markup_percent: null,
        fixed_price: null,
      },
    })
  } catch (error) {
    console.error('Error fetching variation store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/products/[id]/variations/[variationId]/store-pricing
 * Sets or updates a single variation pricing override.
 */
export async function PUT(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id, variationId: varIdParam } = await params
    const productId = parseInt(id, 10)
    const variationId = parseInt(varIdParam, 10)

    const body = await request.json().catch(() => ({}))
    const storeId = parseInt(body.store_id, 10)

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'Missing or invalid store_id' }, { status: 400 })
    }

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    // Verify product belongs to store
    const prodCheck = await db.query(
      `SELECT p.id
       FROM products p
       LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $2
       WHERE p.id = $1 AND (ps.status IS NULL OR ps.status != 'removed')`,
      [productId, storeId]
    )
    if (prodCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found or not mapped to this store' }, { status: 404 })
    }

    // Verify variation belongs to product
    const varRes = await db.query(
      `SELECT id FROM product_variations WHERE id = $1 AND product_id = $2`,
      [variationId, productId]
    )
    if (varRes.rows.length === 0) {
      return NextResponse.json({ error: 'Variation does not belong to specified product' }, { status: 400 })
    }

    const overrideType = body.override_type || 'product_rules'
    if (!['product_rules', 'custom_markup', 'fixed_price'].includes(overrideType)) {
      return NextResponse.json(
        { error: "Invalid override_type. Must be 'product_rules', 'custom_markup', or 'fixed_price'." },
        { status: 400 }
      )
    }

    let customMarkup = null
    let fixedPrice = null

    if (overrideType === 'custom_markup') {
      customMarkup = toNumber(body.custom_markup_percent)
      if (customMarkup === null || customMarkup < 0) {
        return NextResponse.json({ error: 'Custom markup percent must be a non-negative number.' }, { status: 400 })
      }
    } else if (overrideType === 'fixed_price') {
      fixedPrice = toNumber(body.fixed_price)
      if (fixedPrice === null || fixedPrice < 0) {
        return NextResponse.json({ error: 'Fixed price must be a non-negative number.' }, { status: 400 })
      }
    }

    // If override_type is 'product_rules', clean up / reset the variation override row
    if (overrideType === 'product_rules') {
      await db.query(
        'DELETE FROM variation_store_pricing WHERE store_id = $1 AND variation_id = $2',
        [storeId, variationId]
      )
      return NextResponse.json({
        success: true,
        store_id: storeId,
        product_id: productId,
        variation_id: variationId,
        override: {
          override_type: 'product_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      })
    }

    // UPSERT variation override
    const upsertRes = await db.query(
      `INSERT INTO variation_store_pricing (store_id, product_id, variation_id, override_type, custom_markup_percent, fixed_price, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (store_id, variation_id)
       DO UPDATE SET override_type = EXCLUDED.override_type,
                     custom_markup_percent = EXCLUDED.custom_markup_percent,
                     fixed_price = EXCLUDED.fixed_price,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING override_type, custom_markup_percent, fixed_price, updated_at`,
      [storeId, productId, variationId, overrideType, customMarkup, fixedPrice]
    )

    const row = upsertRes.rows[0]
    return NextResponse.json({
      success: true,
      store_id: storeId,
      product_id: productId,
      variation_id: variationId,
      override: {
        override_type: row.override_type,
        custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
        fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
        updated_at: row.updated_at,
      },
    })
  } catch (error) {
    console.error('Error saving variation store pricing override:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * DELETE /api/products/[id]/variations/[variationId]/store-pricing?store_id=4
 * Clears/resets variation override row.
 */
export async function DELETE(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id, variationId: varIdParam } = await params
    const productId = parseInt(id, 10)
    const variationId = parseInt(varIdParam, 10)

    const { searchParams } = new URL(request.url)
    const storeId = parseInt(searchParams.get('store_id'), 10)

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'Missing or invalid store_id' }, { status: 400 })
    }

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    await db.query(
      'DELETE FROM variation_store_pricing WHERE store_id = $1 AND variation_id = $2',
      [storeId, variationId]
    )

    return NextResponse.json({
      success: true,
      store_id: storeId,
      product_id: productId,
      variation_id: variationId,
    })
  } catch (error) {
    console.error('Error resetting variation store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
