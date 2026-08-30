import { NextResponse } from 'next/server'
import { authenticateExportRequest } from '../../../lib/export-auth'

const { upsertOrders } = require('../../../lib/order-import')

/**
 * Receives order payloads pushed from the WordPress "WooApp Connector"
 * plugin. Auth is the same store_id + x-api-key pair used for product
 * export — no WooCommerce Consumer Key/Secret required.
 *
 * Body: a single order object, or { orders: [...] } for batch/backfill.
 */
export async function POST(request) {
  try {
    const auth = await authenticateExportRequest(request)

    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    let rawOrders
    if (Array.isArray(body?.orders)) {
      rawOrders = body.orders
    } else if (body && typeof body === 'object' && (body.woo_order_id != null || body.id != null)) {
      rawOrders = [body]
    } else {
      return NextResponse.json(
        { error: 'Body must be an order object or { orders: [...] }' },
        { status: 400 }
      )
    }

    if (rawOrders.length === 0) {
      return NextResponse.json({ success: true, imported: 0, updated: 0, errors: [] })
    }

    const result = await upsertOrders(auth.store.id, rawOrders)

    return NextResponse.json({
      success: result.errors.length === 0 || result.imported + result.updated > 0,
      imported: result.imported,
      updated: result.updated,
      errors: result.errors,
      store: { id: auth.store.id, name: auth.store.name },
    })
  } catch (error) {
    console.error('Error importing orders:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
