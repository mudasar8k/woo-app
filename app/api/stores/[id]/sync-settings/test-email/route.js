import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../../../lib/auth'
import db from '../../../../../lib/db'
import { sendTestSyncEmail, parseRecipients } from '../../../../../lib/ralawise-notifications'

export const dynamic = 'force-dynamic'

/**
 * POST /api/stores/[id]/sync-settings/test-email
 * Sends a safe test notification email via Resend without running any Ralawise or WordPress sync.
 */
export async function POST(request, { params }) {
  try {
    const session = await requireAdmin()
    const { id } = await params
    const storeId = parseInt(id, 10)

    if (session.user.role !== 'super_admin') {
      const accessCheck = await db.query(
        'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
        [session.user.id, storeId]
      )
      if (accessCheck.rows.length === 0) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
      }
    }

    const storeRes = await db.query(
      `SELECT id, name, ralawise_sync_notify_emails FROM stores WHERE id = $1`,
      [storeId]
    )

    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeRes.rows[0]

    let customRecipients = null
    try {
      const body = await request.json().catch(() => ({}))
      if (body?.recipients) {
        customRecipients = String(body.recipients).trim()
      }
    } catch {
      // ignore json parse errors
    }

    const recipients = parseRecipients(
      customRecipients || store.ralawise_sync_notify_emails,
      process.env.RALAWISE_SYNC_NOTIFY_EMAILS
    )

    if (recipients.length === 0) {
      return NextResponse.json(
        { error: 'No recipient email configured. Please enter a valid notification email address.' },
        { status: 400 }
      )
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { error: 'RESEND_API_KEY environment variable is not configured on the server.' },
        { status: 500 }
      )
    }

    const result = await sendTestSyncEmail({ store, customRecipients })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Failed to send test email via Resend' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      ok: true,
      message: `Test email sent successfully to ${recipients.join(', ')}`,
      recipients,
      emailId: result.id,
    })
  } catch (err) {
    console.error('[API Test Email POST] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Internal error while sending test email' },
      { status: 500 }
    )
  }
}
