import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { toNumber } from '../../../../lib/pricing'

/**
 * GET /api/products/[id]/store-pricing?store_id=4
 * Returns current pricing override for a given product and store.
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

    // Verify product exists and is accessible to this store
    const prodRes = await db.query(
      `SELECT p.id, p.name, p.sku, p.regular_price, p.price
       FROM products p
       LEFT JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $2
       WHERE p.id = $1 AND (p.store_id = $2 OR vs.store_id = $2)`,
      [productId, storeId]
    )

    if (prodRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found or not associated with this store' },
        { status: 404 }
      )
    }

    let override = null
    try {
      const overrideRes = await db.query(
        `SELECT override_type, custom_markup_percent, fixed_price, updated_at
         FROM product_store_pricing
         WHERE store_id = $1 AND product_id = $2 LIMIT 1`,
        [storeId, productId]
      )
      if (overrideRes.rows.length > 0) {
        const row = overrideRes.rows[0]
        override = {
          override_type: row.override_type,
          custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
          fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
          updated_at: row.updated_at,
        }
      }
    } catch {
      override = null
    }

    return NextResponse.json({
      product_id: productId,
      store_id: storeId,
      override: override || {
        override_type: 'store_rules',
        custom_markup_percent: null,
        fixed_price: null,
      },
    })
  } catch (error) {
    console.error('Error fetching product store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/products/[id]/store-pricing
 * Sets or updates a product-specific pricing override for a given store.
 */
export async function PUT(request, { params }) {
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

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'Missing or invalid store_id' }, { status: 400 })
    }

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    // Verify product exists and belongs to this store
    const prodRes = await db.query(
      `SELECT p.id
       FROM products p
       LEFT JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $2
       WHERE p.id = $1 AND (p.store_id = $2 OR vs.store_id = $2)`,
      [productId, storeId]
    )

    if (prodRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found or not associated with this store' },
        { status: 404 }
      )
    }

    const overrideType = body.override_type || 'store_rules'
    if (!['store_rules', 'custom_markup', 'fixed_price'].includes(overrideType)) {
      return NextResponse.json(
        { error: "Invalid override_type. Must be 'store_rules', 'custom_markup', or 'fixed_price'." },
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

    // If override_type is 'store_rules', clean up / reset the override row
    if (overrideType === 'store_rules') {
      await db.query(
        'DELETE FROM product_store_pricing WHERE store_id = $1 AND product_id = $2',
        [storeId, productId]
      )
      return NextResponse.json({
        success: true,
        product_id: productId,
        store_id: storeId,
        override: {
          override_type: 'store_rules',
          custom_markup_percent: null,
          fixed_price: null,
        },
      })
    }

    // UPSERT override
    const upsertRes = await db.query(
      `INSERT INTO product_store_pricing (store_id, product_id, override_type, custom_markup_percent, fixed_price, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (store_id, product_id)
       DO UPDATE SET override_type = EXCLUDED.override_type,
                     custom_markup_percent = EXCLUDED.custom_markup_percent,
                     fixed_price = EXCLUDED.fixed_price,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING override_type, custom_markup_percent, fixed_price, updated_at`,
      [storeId, productId, overrideType, customMarkup, fixedPrice]
    )

    const row = upsertRes.rows[0]
    return NextResponse.json({
      success: true,
      product_id: productId,
      store_id: storeId,
      override: {
        override_type: row.override_type,
        custom_markup_percent: row.custom_markup_percent !== null ? Number(row.custom_markup_percent) : null,
        fixed_price: row.fixed_price !== null ? Number(row.fixed_price) : null,
        updated_at: row.updated_at,
      },
    })
  } catch (error) {
    console.error('Error saving product store pricing override:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * DELETE /api/products/[id]/store-pricing?store_id=4
 * Clears/resets product-specific pricing override.
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
      'DELETE FROM product_store_pricing WHERE store_id = $1 AND product_id = $2',
      [storeId, productId]
    )

    return NextResponse.json({ success: true, product_id: productId, store_id: storeId })
  } catch (error) {
    console.error('Error resetting product store pricing:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}