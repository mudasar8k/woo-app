import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'

/**
 * "Export to Store" for plugin-connected stores.
 *
 * 1. Approves selected products (and bumps updated_at) so the WordPress
 *    connector can pull them on the next import.
 * 2. Best-effort: asks the store's /trigger-import endpoint to start a pull.
 *
 * Approval always succeeds even when WooApp cannot reach WordPress (common
 * from Vercel → Hostinger). The plugin is designed for WP to call out to
 * WooApp; inbound triggers are optional. Use wp-admin → Import Now or the
 * connector schedule when the trigger cannot be reached.
 */
export async function POST(request, { params }) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const storeId = parseInt(id)
    const body = await request.json().catch(() => ({}))
    const fullResync = Boolean(body.full_resync)
    const productIds = Array.isArray(body.product_ids)
      ? body.product_ids.map((value) => parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0)
      : []

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

    const storeResult = await db.query(
      'SELECT id, name, store_url, export_api_key, connection_method FROM stores WHERE id = $1',
      [storeId]
    )

    if (storeResult.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeResult.rows[0]

    if (store.connection_method !== 'plugin') {
      return NextResponse.json(
        { error: 'This store does not use the WooApp Connector plugin - nothing to trigger.' },
        { status: 400 }
      )
    }

    if (!store.store_url || !store.export_api_key) {
      return NextResponse.json(
        { error: 'This store is missing its base URL or export API key.' },
        { status: 400 }
      )
    }

    let approvedCount = 0

    // Selected "Export to Store" products: approve pending/rejected ones so the
    // plugin pull can see them, and bump updated_at so incremental import
    // includes them even if they were already approved.
    if (productIds.length > 0) {
      const placeholders = productIds.map((_, i) => `$${i + 2}`).join(',')
      const eligible = await db.query(
        `SELECT p.id
         FROM products p
         INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1
         WHERE p.id IN (${placeholders})`,
        [storeId, ...productIds]
      )

      const eligibleIds = eligible.rows.map((row) => row.id)
      if (eligibleIds.length === 0) {
        return NextResponse.json(
          { error: 'None of the selected products are available for this store.' },
          { status: 400 }
        )
      }

      const eligiblePlaceholders = eligibleIds.map((_, i) => `$${i + 2}`).join(',')
      await db.query(
        `UPDATE products
         SET status = 'approved',
             reviewed_by = COALESCE(reviewed_by, $1),
             reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${eligiblePlaceholders})`,
        [session.user.id, ...eligibleIds]
      )

      await db.query(
        `UPDATE product_variations
         SET status = 'approved', updated_at = CURRENT_TIMESTAMP
         WHERE product_id IN (${eligibleIds.map((_, i) => `$${i + 1}`).join(',')})
           AND status = 'pending'`,
        eligibleIds
      )

      approvedCount = eligibleIds.length
    }

    await db.query('UPDATE stores SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1', [storeId])

    const triggerUrl = `${store.store_url.replace(/\/$/, '')}/wp-json/wooapp-connector/v1/trigger-import`
    let triggered = false
    let triggerError = null
    let progress = null
    let syncedSkus = []

    try {
      const response = await fetch(triggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': store.export_api_key,
        },
        body: JSON.stringify({ full_resync: fullResync }),
        // WP now queues and returns immediately; keep this short so Vercel
        // does not sit on a blocked Hostinger connection for 30s+.
        signal: AbortSignal.timeout(12000),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        triggerError =
          data?.message || `WordPress rejected the trigger request (HTTP ${response.status}).`
      } else {
        triggered = true
        progress = data
        syncedSkus = Array.isArray(data?.synced_skus) ? data.synced_skus.filter(Boolean) : []
      }
    } catch (fetchError) {
      triggerError = `Could not reach ${store.store_url} (${fetchError.message}).`
    }

    if (syncedSkus.length > 0) {
      await db.query(
        `INSERT INTO product_stores (product_id, store_id, status)
         SELECT p.id, $1, 'synced' FROM products p WHERE p.sku = ANY($2::text[])
         ON CONFLICT (product_id, store_id)
         DO UPDATE SET status = 'synced', updated_at = CURRENT_TIMESTAMP`,
        [storeId, syncedSkus]
      )
    }

    // Products are ready for pull even when the inbound trigger fails —
    // that is the supported architecture for plugin stores.
    if (!triggered) {
      const readyMsg =
        approvedCount > 0
          ? `${approvedCount} product(s) approved and ready for WordPress to pull.`
          : 'Products are ready for WordPress to pull.'

      return NextResponse.json({
        ok: true,
        triggered: false,
        approvedCount,
        syncedCount: 0,
        message: `${readyMsg} ${triggerError || 'Trigger unavailable.'} Open that site's wp-admin → WooApp Connector → Import Now (or wait for the scheduled sync).`,
        triggerError,
      })
    }

    return NextResponse.json({
      ok: true,
      triggered: true,
      approvedCount,
      syncedCount: syncedSkus.length,
      message:
        approvedCount > 0
          ? `${approvedCount} product(s) approved. Import queued on the store.`
          : 'Import queued on the store.',
      progress,
    })
  } catch (error) {
    console.error('Error triggering import:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to trigger import' },
      { status: 500 }
    )
  }
}
