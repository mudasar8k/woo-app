import { NextResponse } from 'next/server'
import { authenticateExportRequest } from '../../../lib/export-auth'
import db from '../../../lib/db'

/**
 * Endpoint for WordPress connector to retrieve products explicitly removed from a store.
 *
 * GET /api/export/removed-products?store_id=4&since=2026-08-28T00:00:00Z
 * Header: x-api-key: <store_api_key>
 */
export async function GET(request) {
  try {
    const auth = await authenticateExportRequest(request)

    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(request.url)
    const since = searchParams.get('since')

    const params = [auth.store.id]
    let sinceCondition = ''
    if (since) {
      params.push(since)
      sinceCondition = ` AND ps.removed_at >= $${params.length}`
    }

    // Return ONLY products whose current store-level status is 'removed'
    const result = await db.query(
      `SELECT p.sku, p.name, ps.removed_at, ps.woo_product_id
       FROM product_stores ps
       JOIN products p ON p.id = ps.product_id
       WHERE ps.store_id = $1 AND ps.status = 'removed'${sinceCondition}
       ORDER BY ps.removed_at DESC`,
      params
    )

    return NextResponse.json({
      ok: true,
      store_id: auth.store.id,
      generated_at: new Date().toISOString(),
      count: result.rows.length,
      removed_products: result.rows.map((r) => ({
        sku: r.sku,
        name: r.name,
        removed_at: r.removed_at,
        woo_product_id: r.woo_product_id,
      })),
    })
  } catch (error) {
    console.error('Error in export removed-products:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
