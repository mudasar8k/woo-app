import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireSuperAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'

/**
 * (Re)generates the export_api_key a store's WordPress "WooApp Connector"
 * plugin uses to authenticate against /api/export/*. Regenerating
 * immediately invalidates the old key.
 */
export async function POST(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params

    const newKey = crypto.randomBytes(24).toString('hex')

    const result = await db.query(
      `UPDATE stores SET export_api_key = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, export_api_key`,
      [newKey, id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    return NextResponse.json(result.rows[0])
  } catch (error) {
    console.error('Error regenerating export API key:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
