import { NextResponse } from 'next/server'
import { authenticateExportRequest } from '../../../lib/export-auth'
import db from '../../../lib/db'
import { resolveCostPrice, resolveStorePrice } from '../../../lib/pricing'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

function splitList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function serializeVariation(row, store) {
  const cost = resolveCostPrice(row)
  const sell = resolveStorePrice(row, store)
  return {
    sku: row.sku,
    price: sell,
    regular_price: sell,
    sale_price: row.sale_price,
    cost_price: cost,
    stock_quantity: row.stock_quantity,
    manage_stock: row.manage_stock,
    stock_status: row.stock_status,
    tax_class: row.tax_class,
    image: row.image || null,
    images: splitList(row.images || row.image),
    color: row.color,
    size: row.size,
    woo_variation_id: row.woo_variation_id,
    updated_at: row.updated_at,
  }
}

function serializeProduct(row, variations, store) {
  const cost = resolveCostPrice(row)
  const sell = resolveStorePrice(row, store)
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    short_description: row.short_description,
    price: sell,
    regular_price: sell,
    sale_price: row.sale_price,
    cost_price: cost,
    stock_quantity: row.stock_quantity,
    manage_stock: row.manage_stock,
    stock_status: row.stock_status,
    categories: splitList(row.categories),
    tags: splitList(row.tags),
    images: splitList(row.images),
    brand: row.brand || null,
    vendor: row.vendor_name || null,
    fabric: row.fabric || null,
    weight: row.weight || null,
    size_description: row.size_description || null,
    length_fit: row.length_fit || null,
    status: row.status,
    woo_product_id: row.woo_product_id,
    updated_at: row.updated_at,
    variations: variations.map((v) => serializeVariation(v, store)),
  }
}

/**
 * Pull-based product export for the WordPress "WooApp Connector" plugin.
 *
 * GET /api/export/products?store_id=1&limit=200&offset=0&updated_since=2026-07-01T00:00:00Z
 * Header: x-api-key: <store's export_api_key>
 */
export async function GET(request) {
  try {
    const auth = await authenticateExportRequest(request)

    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(
      parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT
    )
    const offset = parseInt(searchParams.get('offset') || '0', 10) || 0
    const updatedSince = searchParams.get('updated_since')

    const conditions = [`p.status = 'approved'`, `(ps.status IS NULL OR ps.status != 'removed')`]
    const params = []

    if (updatedSince) {
      params.push(updatedSince)
      conditions.push(`(p.updated_at >= $${params.length} OR ps.updated_at >= $${params.length})`)
    }

    const whereClause = conditions.join(' AND ')

    const totalResult = await db.query(
      `SELECT COUNT(*) AS total
       FROM products p
       LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $${params.length + 1}
       INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $${params.length + 1}
       WHERE ${whereClause}`,
      [...params, auth.store.id]
    )
    const total = parseInt(totalResult.rows[0].total, 10)

    const productsResult = await db.query(
      `SELECT p.*, ps.woo_product_id, v.name AS vendor_name
       FROM products p
       LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $${params.length + 1}
       LEFT JOIN vendors v ON v.id = p.vendor_id
       INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $${params.length + 1}
       WHERE ${whereClause}
       ORDER BY p.id ASC LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [...params, auth.store.id, limit, offset]
    )

    const productIds = productsResult.rows.map((p) => p.id)
    let variationsByProduct = {}

    if (productIds.length > 0) {
      const variationsResult = await db.query(
        `SELECT * FROM product_variations WHERE product_id = ANY($1::int[]) ORDER BY id ASC`,
        [productIds]
      )
      variationsByProduct = variationsResult.rows.reduce((acc, variation) => {
        acc[variation.product_id] = acc[variation.product_id] || []
        acc[variation.product_id].push(variation)
        return acc
      }, {})
    }

    const products = productsResult.rows.map((row) =>
      serializeProduct(row, variationsByProduct[row.id] || [], auth.store)
    )

    const nextOffset = offset + productsResult.rows.length
    const hasMore = nextOffset < total

    return NextResponse.json({
      store: auth.store,
      generated_at: new Date().toISOString(),
      total,
      count: products.length,
      offset,
      limit,
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null,
      products,
    })
  } catch (error) {
    console.error('Error in export products:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
