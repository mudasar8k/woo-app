import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import { authenticateSyncJobRequest } from '../../../../../lib/role-guards'
import {
  JOB_STATUS,
  getSyncJob,
  updateSyncJob,
  serializeJob,
} from '../../../../../lib/ralawise-sync-jobs'

export const runtime = 'nodejs'

export async function POST(request, { params }) {
  try {
    const { id } = await params
    const jobId = parseInt(id, 10)
    if (!jobId || Number.isNaN(jobId)) {
      return NextResponse.json({ error: 'Invalid job id' }, { status: 400 })
    }

    const job = await getSyncJob(db, jobId)
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const authCheck = await authenticateSyncJobRequest(request, job, db, auth)
    if (!authCheck.ok) {
      return NextResponse.json({ error: authCheck.error }, { status: authCheck.status })
    }

    if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.FAILED) {
      return NextResponse.json(
        { error: 'Job already finished' },
        { status: 400 }
      )
    }

    const updated = await updateSyncJob(db, jobId, {
      status: JOB_STATUS.PAUSED,
      cancel_requested: true,
      message: `Paused at ${job.current_count || 0} / ${job.total_count || 0}`,
    })

    return NextResponse.json(serializeJob(updated))
  } catch (error) {
    console.error('Ralawise sync stop failed:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to stop sync' },
      { status: 500 }
    )
  }
}
