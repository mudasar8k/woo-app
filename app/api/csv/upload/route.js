import { NextResponse } from 'next/server'
import db from '../../../lib/db'
import { parseCSV } from '../../../lib/csv-parser'
import { importProductRows, importVariationRows } from '../../../lib/csv-import'
import { auth } from '../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../lib/role-guards'

// Vercel serverless function configuration
export const maxDuration = 60 // Maximum execution time in seconds (60s for Pro, 10s for Hobby)
export const runtime = 'nodejs' // Use Node.js runtime

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const formData = await request.formData()
    const file = formData.get('file')
    const storeIdStr = formData.get('store_id')
    const vendorIdStr = formData.get('vendor_id')
    const fileType = formData.get('file_type')

    const storeId = parseInt(storeIdStr)
    const vendorId = parseInt(vendorIdStr)

    if (!file || !storeIdStr || !vendorIdStr || !fileType) {
      return NextResponse.json(
        { error: 'Missing required fields', details: { hasFile: !!file, storeId: storeIdStr, vendorId: vendorIdStr, fileType } },
        { status: 400 }
      )
    }

    if (isNaN(storeId) || isNaN(vendorId)) {
      return NextResponse.json(
        { error: 'Invalid store ID or vendor ID', details: { storeId, vendorId } },
        { status: 400 }
      )
    }

    // Validate file size (Vercel has 4.5MB limit for request body, but we'll use 3MB to be safe)
    const MAX_FILE_SIZE = 3 * 1024 * 1024 // 3MB
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File size exceeds limit. Maximum size is ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB. Please split your CSV file into smaller files.`,
          fileSize: file.size,
          maxSize: MAX_FILE_SIZE,
        },
        { status: 413 }
      )
    }

    console.log(`Processing CSV upload: file=${file.name}, size=${(file.size / 1024).toFixed(2)}KB, type=${fileType}`)

    let fileText
    try {
      const fileBuffer = await file.arrayBuffer()
      fileText = Buffer.from(fileBuffer).toString('utf-8')
    } catch (error) {
      console.error('Error reading file:', error)
      return NextResponse.json(
        { error: 'Failed to read file. Please ensure the file is a valid CSV file.' },
        { status: 400 }
      )
    }

    let csvData
    try {
      csvData = await parseCSV(fileText)
    } catch (error) {
      console.error('Error parsing CSV:', error)
      return NextResponse.json(
        { error: 'Failed to parse CSV file. Please ensure the file is properly formatted.' },
        { status: 400 }
      )
    }

    if (csvData.length === 0) {
      return NextResponse.json(
        { error: 'CSV file is empty' },
        { status: 400 }
      )
    }

    if (csvData.length > 0) {
      console.log('CSV First row columns:', Object.keys(csvData[0]))
      console.log('CSV First row sample:', csvData[0])
    }

    const uploadResult = await db.query(
      `INSERT INTO csv_uploads (store_id, vendor_id, uploaded_by, file_type, file_name, row_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing')
       RETURNING id`,
      [storeId, vendorId, session.user.id, fileType, file.name, csvData.length]
    )

    const csvUploadId = uploadResult.rows[0].id

    try {
      let result = { processedCount: 0, newCount: 0, updatedCount: 0, errors: [] }

      if (fileType === 'products') {
        console.log(`Processing ${csvData.length} product rows`)
        result = await importProductRows({
          rows: csvData,
          vendorId,
          csvUploadId,
          db,
        })
      } else if (fileType === 'variations') {
        console.log(`Processing ${csvData.length} variation rows`)
        result = await importVariationRows({
          rows: csvData,
          csvUploadId,
          db,
        })
      }

      await db.query(
        `UPDATE csv_uploads
         SET status = $1, row_count = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          'completed',
          result.processedCount,
          result.errors.length > 0 ? result.errors.slice(0, 50).join('\n') : null,
          csvUploadId,
        ]
      )

      console.log(
        `CSV upload completed: ${result.processedCount} processed (${result.newCount} new, ${result.updatedCount} updated), ${result.errors.length} errors`
      )

      return NextResponse.json({
        message: 'CSV uploaded and processed successfully',
        csvUploadId,
        rowCount: result.processedCount,
        totalRows: csvData.length,
        newCount: result.newCount,
        updatedCount: result.updatedCount,
        errors: result.errors.length > 0 ? result.errors.slice(0, 100) : undefined,
        errorCount: result.errors.length,
      })
    } catch (error) {
      await db.query(
        `UPDATE csv_uploads
         SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [error.message, csvUploadId]
      )

      throw error
    }
  } catch (error) {
    console.error('Error uploading CSV:', error)

    if (error.message && error.message.includes('FUNCTION_PAYLOAD_TOO_LARGE')) {
      return NextResponse.json(
        {
          error: 'File is too large. Maximum file size is 3MB. Please split your CSV file into smaller files or compress it.',
          code: 'PAYLOAD_TOO_LARGE',
        },
        { status: 413 }
      )
    }

    return NextResponse.json(
      { error: error.message || 'Failed to upload CSV' },
      { status: 500 }
    )
  }
}
