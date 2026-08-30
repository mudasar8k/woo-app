import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { importProductRows, importVariationRows } from '../../../lib/csv-import'
import { auth } from '../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../lib/role-guards'

export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json()
    const {
      csvUploadId,
      storeId,
      vendorId,
      fileType,
      chunk,
      chunkIndex,
      totalChunks,
    } = body

    if (!csvUploadId || !storeId || !vendorId || !fileType || !chunk || !Array.isArray(chunk)) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const uploadCheck = await db.query(
      `SELECT cu.id, cu.store_id, cu.vendor_id, cu.status,
              cu.last_chunk_index, cu.processed_row_count
       FROM csv_uploads cu
       WHERE cu.id = $1`,
      [csvUploadId]
    )

    if (uploadCheck.rows.length === 0) {
      return NextResponse.json(
        { error: 'CSV upload record not found' },
        { status: 404 }
      )
    }

    const uploadRecord = uploadCheck.rows[0]

    if (uploadRecord.status === 'completed') {
      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount: 0,
        newCount: 0,
        updatedCount: 0,
        errorCount: 0,
        errors: [],
        isLastChunk: true,
        skipped: true,
        message: 'Upload already completed',
      })
    }

    const lastCompleted = uploadRecord.last_chunk_index ?? -1
    if (typeof chunkIndex === 'number' && chunkIndex <= lastCompleted) {
      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount: 0,
        newCount: 0,
        updatedCount: 0,
        errorCount: 0,
        errors: [],
        isLastChunk: chunkIndex === totalChunks - 1,
        skipped: true,
        message: 'Chunk already processed',
      })
    }

    try {
      const rowOffset =
        typeof chunkIndex === 'number' && totalChunks
          ? chunkIndex * chunk.length
          : 0

      let result = { processedCount: 0, newCount: 0, updatedCount: 0, errors: [] }

      if (fileType === 'products') {
        result = await importProductRows({
          rows: chunk,
          vendorId,
          csvUploadId,
          db,
          rowOffset,
        })
      } else if (fileType === 'variations') {
        result = await importVariationRows({
          rows: chunk,
          csvUploadId,
          db,
          rowOffset,
        })
      }

      const errorText =
        result.errors.length > 0 ? result.errors.slice(0, 50).join('\n') : null

      if (errorText) {
        await db.query(
          `UPDATE csv_uploads
           SET processed_row_count = COALESCE(processed_row_count, 0) + $1,
               last_chunk_index = GREATEST(COALESCE(last_chunk_index, -1), $2),
               error_message = COALESCE(error_message || '\n' || $3::text, $3::text),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [result.processedCount, chunkIndex, errorText, csvUploadId]
        )
      } else {
        await db.query(
          `UPDATE csv_uploads
           SET processed_row_count = COALESCE(processed_row_count, 0) + $1,
               last_chunk_index = GREATEST(COALESCE(last_chunk_index, -1), $2),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [result.processedCount, chunkIndex, csvUploadId]
        )
      }

      return NextResponse.json({
        success: true,
        chunkIndex,
        processedCount: result.processedCount,
        newCount: result.newCount,
        updatedCount: result.updatedCount,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10),
        isLastChunk: chunkIndex === totalChunks - 1,
      })
    } catch (error) {
      console.error('Error processing chunk:', error)
      return NextResponse.json(
        { error: error.message || 'Failed to process chunk' },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error in chunk upload:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to upload chunk' },
      { status: 500 }
    )
  }
}
