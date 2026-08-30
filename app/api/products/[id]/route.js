import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'

export async function PUT(request, { params }) {
  try {
    const session = await requireAdmin()
    const { id } = await params
    
    const body = await request.json()
    const { name, sku, description, short_description, price, regular_price, sale_price, stock_quantity, stock_status, categories, tags } = body

    const result = await db.query(
      `UPDATE products 
       SET name = $1, sku = $2, description = $3, short_description = $4, 
           price = $5, regular_price = $6, sale_price = $7, stock_quantity = $8,
           stock_status = $9, categories = $10, tags = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $12
       RETURNING *`,
      [
        name,
        sku || null,
        description || null,
        short_description || null,
        price ? parseFloat(price) : null,
        regular_price ? parseFloat(regular_price) : null,
        sale_price ? parseFloat(sale_price) : null,
        stock_quantity ? parseInt(stock_quantity) : null,
        stock_status || 'instock',
        categories || null,
        tags || null,
        id,
      ]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(result.rows[0])
  } catch (error) {
    console.error('Error updating product:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}




