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
  loadProductVariationStoreOverrides,
  toNumber,
} from '@/app/lib/pricing'

/**
 * GET /api/products/[id]/variations/store-pricing?store_id=4
 * Returns all variations of a product with their attributes, supplier cost, resolved price, source, and override state.
 */
export async function GET(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const productId = parseInt(id, 10)

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
       JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $2
       WHERE p.id = $1 AND (ps.status IS NULL OR ps.status != 'removed')`,
      [productId, storeId]
    )
    if (prodCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found or not mapped to this store' }, { status: 404 })
    }
    const product = prodCheck.rows[0]

    // Fetch all variations, store engine, product override, and variation overrides in parallel
    const [
      varRes,
      { storeContext, rangeRules, categoryRules },
      productOverridesMap,
      varOverridesMap,
    ] = await Promise.all([
      db.query(
        `SELECT id, product_id, sku, price, regular_price, sale_price, size, color
         FROM product_variations
         WHERE product_id = $1
         ORDER BY id ASC`,
        [productId]
      ),
      loadStorePricingEngine(db, storeId),
      loadProductStoreOverrides(db, storeId, [productId]),
      loadProductVariationStoreOverrides(db, storeId, productId),
    ])

    const productOverride = productOverridesMap.get(productId) || null

    const variationsList = varRes.rows.map((v) => {
      const varOverride = varOverridesMap.get(v.id) || null
      const cost = resolveCostPrice(v)
      const calc = resolveItemPrice(
        cost,
        storeContext,
        rangeRules,
        productOverride,
        product.categories,
        categoryRules,
        varOverride
      )

      return {
        id: v.id,
        sku: v.sku,
        size: v.size,
        color: v.color,
        supplier_cost: cost,
        selling_price: calc.sellingPrice,
        source: calc.source,
        applied_markup: calc.appliedMarkup,
        override: varOverride || {
          override_type: 'product_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      }
    })

    return NextResponse.json({
      store_id: storeId,
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        categories: product.categories,
        override: productOverride || {
          override_type: 'store_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      },
      variations: variationsList,
      total_variations: variationsList.length,
      overridden_variations_count: varOverridesMap.size,
    })
  } catch (error) {
    console.error('Error fetching product variations store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/products/[id]/variations/store-pricing (BULK OR SINGLE SAVE)
 * Saves variation overrides for multiple variations inside a transaction.
 */
export async function PUT(request, { params }) {
  let client
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const productId = parseInt(id, 10)

    const body = await request.json().catch(() => ({}))
    const storeId = parseInt(body.store_id, 10)
    const rawOverrides = Array.isArray(body.overrides) ? body.overrides : []

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
       JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $2
       WHERE p.id = $1 AND (ps.status IS NULL OR ps.status != 'removed')`,
      [productId, storeId]
    )
    if (prodCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found or not mapped to this store' }, { status: 404 })
    }

    // Fetch valid variation IDs for this product
    const validVarsRes = await db.query(
      'SELECT id FROM product_variations WHERE product_id = $1',
      [productId]
    )
    const validVarIds = new Set(validVarsRes.rows.map((r) => r.id))

    client = await db.pool.connect()
    await client.query('BEGIN')

    const savedResults = []

    for (const item of rawOverrides) {
      const variationId = parseInt(item.variation_id, 10)
      if (!validVarIds.has(variationId)) {
        await client.query('ROLLBACK').catch(() => {})
        return NextResponse.json(
          { error: `Variation ID ${variationId} does not belong to product ${productId}` },
          { status: 400 }
        )
      }

      const overrideType = item.override_type || 'product_rules'
      if (!['product_rules', 'custom_markup', 'fixed_price'].includes(overrideType)) {
        await client.query('ROLLBACK').catch(() => {})
        return NextResponse.json(
          { error: `Invalid override_type '${overrideType}' for variation ${variationId}` },
          { status: 400 }
        )
      }

      if (overrideType === 'product_rules') {
        await client.query(
          'DELETE FROM variation_store_pricing WHERE store_id = $1 AND variation_id = $2',
          [storeId, variationId]
        )
        savedResults.push({
          variation_id: variationId,
          override_type: 'product_rules',
          custom_markup_percent: null,
          fixed_price: null,
        })
      } else {
        const customMarkup = overrideType === 'custom_markup' ? toNumber(item.custom_markup_percent) : null
        const fixedPrice = overrideType === 'fixed_price' ? toNumber(item.fixed_price) : null

        if (overrideType === 'custom_markup' && (customMarkup === null || customMarkup < 0)) {
          await client.query('ROLLBACK').catch(() => {})
          return NextResponse.json(
            { error: `Custom markup percent must be a non-negative number for variation ${variationId}` },
            { status: 400 }
          )
        }
        if (overrideType === 'fixed_price' && (fixedPrice === null || fixedPrice < 0)) {
          await client.query('ROLLBACK').catch(() => {})
          return NextResponse.json(
            { error: `Fixed price must be a non-negative number for variation ${variationId}` },
            { status: 400 }
          )
        }

        const upsertRes = await client.query(
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
        savedResults.push({
          variation_id: variationId,
          override_type: row.override_type,
          custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
          fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
        })
      }
    }

    await client.query('COMMIT')

    return NextResponse.json({
      success: true,
      store_id: storeId,
      product_id: productId,
      saved_count: savedResults.length,
      overrides: savedResults,
    })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Error saving variation store pricing overrides:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  } finally {
    if (client) client.release()
  }
}

/**
 * DELETE /api/products/[id]/variations/store-pricing (BULK OR FULL RESET FOR PRODUCT)
 */
export async function DELETE(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const productId = parseInt(id, 10)

    const { searchParams } = new URL(request.url)
    const storeId = parseInt(searchParams.get('store_id'), 10)
    const varIdsParam = searchParams.get('variation_ids')

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'Missing or invalid store_id' }, { status: 400 })
    }

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    if (varIdsParam) {
      const variationIds = varIdsParam.split(',').map((v) => parseInt(v.trim(), 10)).filter(Boolean)
      await db.query(
        'DELETE FROM variation_store_pricing WHERE store_id = $1 AND product_id = $2 AND variation_id = ANY($3::int[])',
        [storeId, productId, variationIds]
      )
    } else {
      // Reset all variation overrides for this product
      await db.query(
        'DELETE FROM variation_store_pricing WHERE store_id = $1 AND product_id = $2',
        [storeId, productId]
      )
    }

    return NextResponse.json({
      success: true,
      store_id: storeId,
      product_id: productId,
    })
  } catch (error) {
    console.error('Error resetting product variation store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
