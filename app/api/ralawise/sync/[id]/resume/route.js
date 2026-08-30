import { NextResponse, after } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../../lib/role-guards'
import {
  JOB_STATUS,
  getSyncJob,
  serializeJob,
} from '../../../../../lib/ralawise-sync-jobs'
import { runSyncJobWorker } from '../../../../../lib/ralawise-sync-runner'

export const maxDuration = 300
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
      const hasAccess = await verifyAdminStoreAccess(
        db,
        session.user.id,
        job.store_id
      )
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Unauthorized access to this store' },
          { status: 403 }
        )
      }
    }

    if (job.status !== JOB_STATUS.PAUSED) {
      return NextResponse.json(
        { error: 'Only paused jobs can be resumed' },
        { status: 400 }
      )
    }

    after(async () => {
      await runSyncJobWorker(db, job, { resume: true })
    })

    return NextResponse.json({
      ...serializeJob(job),
      status: job.step || JOB_STATUS.CONNECTING,
      message: 'Resuming…',
    })
  } catch (error) {
    console.error('Ralawise sync resume failed:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to resume sync' },
      { status: 500 }
    )
  }
}
