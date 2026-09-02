import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { prepareRalawiseSync } from '../../../../lib/ralawise-batch-importer'
import { getActiveSyncJobForStore, serializeJob } from '../../../../lib/ralawise-sync-jobs'

export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json().catch(() => ({}))
    const storeId = parseInt(body.store_id, 10)
    const vendorId = parseInt(
      body.vendor_id ?? process.env.RALAWISE_DEFAULT_VENDOR_ID,
      10
    )

    if (!storeId || Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'store_id is required' }, { status: 400 })
    }
    if (!vendorId || Number.isNaN(vendorId)) {
      return NextResponse.json(
        { error: 'vendor_id is required (or set RALAWISE_DEFAULT_VENDOR_ID)' },
        { status: 400 }
      )
    }

    if (session.user.role === 'admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    const storeCheck = await db.query('SELECT id FROM stores WHERE id = $1', [storeId])
    if (storeCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const vendorCheck = await db.query(
      `SELECT id FROM vendors WHERE id = $1 AND status = 'active'`,
      [vendorId]
    )
    if (vendorCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Vendor not found or inactive' }, { status: 404 })
    }

    // Guard against concurrent syncs. If a non-terminal job already exists as the
    // most-recent job for this store, return it instead of creating a duplicate.
    const existingJob = await getActiveSyncJobForStore(db, storeId)
    if (existingJob) {
      return NextResponse.json(
        {
          error: 'A sync is already in progress. Stop or wait for it to finish before starting a new one.',
          job: serializeJob(existingJob),
        },
        { status: 409 }
      )
    }

    const result = await prepareRalawiseSync({
      storeId,
      vendorId,
      userId: session.user.id,
      db,
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('Ralawise sync prepare error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to prepare Ralawise sync' },
      { status: 500 }
    )
  }
}
