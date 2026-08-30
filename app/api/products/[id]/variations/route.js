import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

export async function GET(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const productId = parseInt(id)
    const { searchParams } = new URL(request.url)
    const storeId = parseInt(searchParams.get('store_id'))

    if (!storeId) {
      return NextResponse.json({ error: 'store_id is required' }, { status: 400 })
    }

    // Product approval is global (see export/products/route.js), so the
    // access boundary is simply whether the product exists at all.
    const productCheck = await db.query('SELECT id FROM products WHERE id = $1', [productId])

    if (productCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Check if admin has access to this store
    if (session.user.role !== 'super_admin') {
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

    // Get variations
    const variationsResult = await db.query(
      `SELECT id, sku, attributes, size, color, price, regular_price, sale_price,
              stock_quantity, stock_status, tax_class, image, images, status
       FROM product_variations
       WHERE product_id = $1
       ORDER BY created_at DESC`,
      [productId]
    )

    return NextResponse.json({
      success: true,
      variations: variationsResult.rows,
    })
  } catch (error) {
    console.error('Error fetching variations:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch variations' },
      { status: 500 }
    )
  }
}
