import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import { authenticateSyncJobRequest } from '../../../../../lib/role-guards'
import { getSyncJob } from '../../../../../lib/ralawise-sync-jobs'
import { finalizeRalawiseSync } from '../../../../../lib/ralawise-batch-importer'

export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request, { params }) {
  try {
    const { id } = await params
    const jobId = parseInt(id, 10)
    if (!jobId || Number.isNaN(jobId)) {
      return NextResponse.json({ error: 'Invalid job ID' }, { status: 400 })
    }

    const job = await getSyncJob(db, jobId)
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const authCheck = await authenticateSyncJobRequest(request, job, db, auth)
    if (!authCheck.ok) {
      return NextResponse.json({ error: authCheck.error }, { status: authCheck.status })
    }

    const result = await finalizeRalawiseSync(db, jobId)

    return NextResponse.json(result)
  } catch (error) {
    console.error('Finalize sync processing error:', error)
    return NextResponse.json(
      { error: error.message || 'Finalize sync processing failed' },
      { status: 500 }
    )
  }
}
