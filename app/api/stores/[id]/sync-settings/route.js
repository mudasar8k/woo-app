import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/stores/[id]/sync-settings
 */
export async function GET(request, { params }) {
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
      `SELECT id, name, ralawise_auto_sync_enabled, ralawise_sync_time,
              ralawise_sync_timezone, ralawise_sync_notify_emails,
              last_scheduled_sync_at, last_scheduled_sync_status,
              last_scheduled_sync_message, last_scheduled_email_at
       FROM stores WHERE id = $1`,
      [storeId]
    )

    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeRes.rows[0]

    // Fetch the latest sync job for additional status observability
    const lastJobRes = await db.query(
      `SELECT id, trigger_source, status, phase, parent_processed, parent_total,
              variation_processed, variation_total, products_new, products_updated,
              variations_new, variations_updated, started_at, completed_at,
              completion_email_sent_at, failure_email_sent_at
       FROM ralawise_sync_jobs
       WHERE store_id = $1
       ORDER BY id DESC LIMIT 1`,
      [storeId]
    )

    const lastJob = lastJobRes.rows[0] || null

    return NextResponse.json({
      ok: true,
      storeId: store.id,
      storeName: store.name,
      enabled: Boolean(store.ralawise_auto_sync_enabled),
      syncTime: store.ralawise_sync_time || '14:00',
      timezone: store.ralawise_sync_timezone || 'Europe/London',
      notifyEmails: store.ralawise_sync_notify_emails || '',
      lastScheduledSyncAt: store.last_scheduled_sync_at,
      lastScheduledStatus: store.last_scheduled_sync_status || lastJob?.status || null,
      lastScheduledMessage: store.last_scheduled_sync_message,
      lastScheduledEmailAt: store.last_scheduled_email_at,
      lastJob: lastJob
        ? {
            id: lastJob.id,
            triggerSource: lastJob.trigger_source || 'manual',
            status: lastJob.status,
            phase: lastJob.phase,
            startedAt: lastJob.started_at,
            completedAt: lastJob.completed_at,
            completionEmailSentAt: lastJob.completion_email_sent_at,
            failureEmailSentAt: lastJob.failure_email_sent_at,
          }
        : null,
      globalScheduleEnabled: process.env.RALAWISE_SYNC_SCHEDULE_ENABLED === 'true',
    })
  } catch (err) {
    console.error('[API Sync Settings GET] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Failed to load sync settings' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/stores/[id]/sync-settings
 */
export async function PUT(request, { params }) {
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

    const body = await request.json()
    const enabled = Boolean(body.enabled)
    const syncTime = String(body.syncTime || '14:00').trim()
    const timezone = 'Europe/London' // strictly enforce UK local time
    const notifyEmails = String(body.notifyEmails || '').trim()

    // Validate syncTime format HH:mm
    if (!/^\d{1,2}:\d{2}$/.test(syncTime)) {
      return NextResponse.json(
        { error: 'Invalid time format. Please use HH:mm (e.g. 14:00)' },
        { status: 400 }
      )
    }

    const [h, m] = syncTime.split(':').map((v) => parseInt(v, 10))
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return NextResponse.json(
        { error: 'Invalid time. Hours must be 00-23 and minutes 00-59' },
        { status: 400 }
      )
    }

    const formattedTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

    const updateRes = await db.query(
      `UPDATE stores SET
         ralawise_auto_sync_enabled = $1,
         ralawise_sync_time = $2,
         ralawise_sync_timezone = $3,
         ralawise_sync_notify_emails = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, ralawise_auto_sync_enabled, ralawise_sync_time, ralawise_sync_timezone, ralawise_sync_notify_emails`,
      [enabled, formattedTime, timezone, notifyEmails, storeId]
    )

    if (updateRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const updated = updateRes.rows[0]

    return NextResponse.json({
      ok: true,
      enabled: updated.ralawise_auto_sync_enabled,
      syncTime: updated.ralawise_sync_time,
      timezone: updated.ralawise_sync_timezone,
      notifyEmails: updated.ralawise_sync_notify_emails,
    })
  } catch (err) {
    console.error('[API Sync Settings PUT] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Failed to save sync settings' },
      { status: 500 }
    )
  }
}
