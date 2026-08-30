import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../../../lib/role-guards'

export const runtime = 'nodejs'

export async function GET(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const csvUploadId = parseInt(id, 10)

    const result = await db.query(
      `SELECT id, store_id, vendor_id, file_type, file_name, status,
              expected_row_count, processed_row_count, last_chunk_index,
              total_chunks, error_message, created_at, updated_at
       FROM csv_uploads
       WHERE id = $1`,
      [csvUploadId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
    }

    const upload = result.rows[0]
    const totalChunks = upload.total_chunks || 0
    const lastChunk = upload.last_chunk_index ?? -1
    const canResume = upload.status === 'processing' && lastChunk < totalChunks - 1

    return NextResponse.json({
      ...upload,
      canResume,
      nextChunkIndex: lastChunk + 1,
      progressPercent:
        totalChunks > 0 ? Math.round(((lastChunk + 1) / totalChunks) * 100) : 0,
    })
  } catch (error) {
    console.error('Error fetching upload status:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch upload status' },
      { status: 500 }
    )
  }
}
