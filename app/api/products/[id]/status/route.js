import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../../lib/role-guards'

export async function PUT(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const body = await request.json()
    const { status } = body

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status' },
        { status: 400 }
      )
    }

    // Approval is global, not per-store (see export/products/route.js) -
    // product_stores is now used purely for per-store sync bookkeeping.
    const result = await db.query(
      `UPDATE products
       SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [status, session.user.id, id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    // If product is being approved, also approve all associated variations
    // (variation status/woo_variation_id stay global, not per-store - see
    // scripts/migrate-product-store-links.js for why).
    if (status === 'approved') {
      const variationsResult = await db.query(
        `UPDATE product_variations
         SET status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE product_id = $1 AND status = 'pending'
         RETURNING id`,
        [id]
      )

      console.log(`Approved ${variationsResult.rows.length} variations for product ${id}`)
    }

    return NextResponse.json({
      ...result.rows[0],
      variationsApproved: status === 'approved' ? (await db.query(
        `SELECT COUNT(*) as count FROM product_variations WHERE product_id = $1 AND status = 'approved'`,
        [id]
      )).rows[0].count : 0
    })
  } catch (error) {
    console.error('Error updating product status:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}
