import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import { authenticateSyncJobRequest } from '../../../../../lib/role-guards'
import { getSyncJob, serializeJob } from '../../../../../lib/ralawise-sync-jobs'

export const runtime = 'nodejs'

export async function GET(request, { params }) {
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

    return NextResponse.json(serializeJob(job))
  } catch (error) {
    console.error('Ralawise sync status failed:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to load sync status' },
      { status: 500 }
    )
  }
}
