import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../../lib/role-guards'
import {
  JOB_STATUS,
  getSyncJob,
  updateSyncJob,
  serializeJob,
} from '../../../../../lib/ralawise-sync-jobs'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const jobId = parseInt(id, 10)
    if (!jobId || Number.isNaN(jobId)) {
      return NextResponse.json({ error: 'Invalid job id' }, { status: 400 })
    }

    const job = await getSyncJob(db, jobId)
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    if (session.user.role === 'admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, job.store_id)
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    if (
      job.status === JOB_STATUS.COMPLETED ||
      job.status === JOB_STATUS.FAILED ||
      job.status === JOB_STATUS.ABANDONED
    ) {
      return NextResponse.json(
        { error: 'Job is already in a terminal state and cannot be abandoned' },
        { status: 400 }
      )
    }

    if (job.status !== JOB_STATUS.PAUSED) {
      return NextResponse.json(
        { error: 'Only paused jobs can be abandoned. Stop the sync first.' },
        { status: 409 }
      )
    }

    const updated = await updateSyncJob(db, jobId, {
      status: JOB_STATUS.ABANDONED,
      cancel_requested: true,
      completed_at: new Date(),
      message: `Abandoned at ${job.variation_cursor || job.current_count || 0} / ${job.variation_total || job.total_count || 0}`,
    })

    return NextResponse.json({ ok: true, job: serializeJob(updated) })
  } catch (error) {
    console.error('Ralawise sync abandon failed:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to abandon sync' },
      { status: 500 }
    )
  }
}
