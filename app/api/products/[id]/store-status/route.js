import { NextResponse } from 'next/server'
import { auth } from '../../../auth/[...nextauth]/route'
import db from '../../../../lib/db'

export async function PUT(request, { params }) {
  try {
    const session = await auth()
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized: Authentication required' }, { status: 401 })
    }

    const { id } = await params
    const productId = parseInt(id, 10)
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 })
    }

    const body = await request.json()
    const { store_id, action } = body
    const storeId = parseInt(store_id, 10)

    if (isNaN(storeId)) {
      return NextResponse.json({ error: 'Invalid store ID' }, { status: 400 })
    }

    if (!['remove', 'restore'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action. Expected "remove" or "restore"' }, { status: 400 })
    }

    // Role-based store access control
    if (session.user.role === 'admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )
      if (accessCheck.rows.length === 0) {
        return NextResponse.json({ error: 'Forbidden: You do not have permission to manage this store' }, { status: 403 })
      }
    } else if (session.user.role !== 'super_admin') {
      return NextResponse.json({ error: 'Forbidden: Insufficient privileges' }, { status: 403 })
    }

    // Verify store exists
    const storeCheck = await db.query('SELECT id, name FROM stores WHERE id = $1', [storeId])
    if (storeCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    // Verify product exists and belongs to a vendor linked to this store
    const productCheck = await db.query(
      `SELECT p.id, p.sku, p.name, p.status, vs.id AS vendor_store_id
       FROM products p
       LEFT JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1
       WHERE p.id = $2`,
      [storeId, productId]
    )

    if (productCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    if (!productCheck.rows[0].vendor_store_id) {
      return NextResponse.json({ error: 'Product vendor is not assigned to this store' }, { status: 400 })
    }

    let result
    if (action === 'remove') {
      result = await db.query(
        `INSERT INTO product_stores (product_id, store_id, status, previous_status, removed_at, removed_by, updated_at)
         VALUES ($1, $2, 'removed', 'approved', CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id, store_id)
         DO UPDATE SET
           previous_status = CASE WHEN product_stores.status != 'removed' THEN product_stores.status ELSE product_stores.previous_status END,
           status = 'removed',
           removed_at = CURRENT_TIMESTAMP,
           removed_by = $3,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [productId, storeId, session.user.id]
      )
    } else {
      // action === 'restore'
      result = await db.query(
        `INSERT INTO product_stores (product_id, store_id, status, removed_at, removed_by, updated_at)
         VALUES ($1, $2, 'approved', NULL, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT (product_id, store_id)
         DO UPDATE SET
           status = COALESCE(product_stores.previous_status, 'approved'),
           removed_at = NULL,
           removed_by = NULL,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [productId, storeId]
      )
    }

    return NextResponse.json({
      success: true,
      action,
      store_id: storeId,
      product_id: productId,
      sku: productCheck.rows[0].sku,
      record: result.rows[0],
    })
  } catch (error) {
    console.error('Error updating store-level product status:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
