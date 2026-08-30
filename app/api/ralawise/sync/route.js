import { NextResponse, after } from 'next/server'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../lib/role-guards'
import {
  JOB_STATUS,
  createSyncJob,
} from '../../../lib/ralawise-sync-jobs'
import { runSyncJobWorker } from '../../../lib/ralawise-sync-runner'

export const maxDuration = 300
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

    const job = await createSyncJob(db, {
      storeId,
      vendorId,
      userId: session.user.id,
    })

    after(async () => {
      await runSyncJobWorker(db, job, { resume: false })
    })

    return NextResponse.json({
      jobId: job.id,
      status: JOB_STATUS.QUEUED,
    })
  } catch (error) {
    console.error('Ralawise sync failed to start:', error)
    return NextResponse.json(
      { error: error.message || 'Ralawise sync failed' },
      { status: 500 }
    )
  }
}
