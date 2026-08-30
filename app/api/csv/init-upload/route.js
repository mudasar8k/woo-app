import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../lib/role-guards'

export const maxDuration = 10
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json()
    const { storeId, vendorId, fileType, fileName, totalRows, totalChunks } = body

    if (!storeId || !vendorId || !fileType || !fileName || !totalRows) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const chunks = totalChunks || Math.ceil(totalRows / 100)

    // Create CSV upload record
    const uploadResult = await db.query(
      `INSERT INTO csv_uploads (
         store_id, vendor_id, uploaded_by, file_type, file_name,
         row_count, expected_row_count, total_chunks, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'processing')
       RETURNING id`,
      [storeId, vendorId, session.user.id, fileType, fileName, totalRows, chunks]
    )

    const csvUploadId = uploadResult.rows[0].id

    return NextResponse.json({
      success: true,
      csvUploadId,
    })
  } catch (error) {
    console.error('Error initializing CSV upload:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to initialize CSV upload' },
      { status: 500 }
    )
  }
}
