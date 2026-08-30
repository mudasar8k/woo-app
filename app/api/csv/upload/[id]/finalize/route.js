import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../../../lib/role-guards'

export const maxDuration = 10
export const runtime = 'nodejs'

export async function POST(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const csvUploadId = parseInt(id)

    // Get upload record
    const uploadResult = await db.query(
      `SELECT id, row_count, error_message FROM csv_uploads WHERE id = $1`,
      [csvUploadId]
    )

    if (uploadResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'CSV upload record not found' },
        { status: 404 }
      )
    }

    const upload = uploadResult.rows[0]

    // Update status to completed
    await db.query(
      `UPDATE csv_uploads 
       SET status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [csvUploadId]
    )

    return NextResponse.json({
      success: true,
      csvUploadId,
      rowCount: upload.row_count || 0,
      hasErrors: !!upload.error_message,
    })
  } catch (error) {
    console.error('Error finalizing CSV upload:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to finalize CSV upload' },
      { status: 500 }
    )
  }
}
