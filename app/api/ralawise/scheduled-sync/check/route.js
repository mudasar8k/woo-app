import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import {
  isScheduleDue,
  runHeadlessSync,
  getUkDateString,
  getUkTimeComponents,
} from '../../../../lib/ralawise-scheduler'
import { getActiveSyncJobForStore } from '../../../../lib/ralawise-sync-jobs'

export const dynamic = 'force-dynamic'

/**
 * Authenticate incoming cron/scheduler request via bearer token or header.
 */
function authenticateSchedulerRequest(request) {
  const cronSecret = process.env.RALAWISE_SYNC_CRON_SECRET
  if (!cronSecret) {
    // If no secret configured in environment, disallow execution for safety
    return { ok: false, status: 401, error: 'RALAWISE_SYNC_CRON_SECRET is not configured' }
  }

  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const xCronHeader = request.headers.get('x-cron-secret') || ''

  if (token === cronSecret || xCronHeader === cronSecret) {
    return { ok: true }
  }

  return { ok: false, status: 401, error: 'Unauthorized: Invalid cron secret' }
}

/**
 * POST /api/ralawise/scheduled-sync/check
 * Periodic scheduler check invoked by GitHub Actions or Vercel Cron.
 */
export async function POST(request) {
  const auth = authenticateSchedulerRequest(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  }

  const globalEnabled = process.env.RALAWISE_SYNC_SCHEDULE_ENABLED === 'true'
  const ukDate = getUkDateString(new Date())
  const ukTime = getUkTimeComponents(new Date())

  // If global feature flag is off, return early without running
  if (!globalEnabled) {
    return NextResponse.json({
      ok: true,
      message: 'Scheduler checked: Global feature flag RALAWISE_SYNC_SCHEDULE_ENABLED is disabled.',
      global_enabled: false,
      uk_date: ukDate,
      uk_time: `${String(ukTime.hour).padStart(2, '0')}:${String(ukTime.minute).padStart(2, '0')}`,
      executed: [],
      skipped: [],
    })
  }

  try {
    // 1. Find all active stores with automatic sync enabled
    const storesRes = await db.query(
      `SELECT id, name, status, ralawise_auto_sync_enabled, ralawise_sync_time,
              ralawise_sync_timezone, ralawise_sync_notify_emails, last_scheduled_sync_at
       FROM stores
       WHERE ralawise_auto_sync_enabled = true AND status = 'active'
       ORDER BY id ASC`
    )

    const executed = []
    const skipped = []

    for (const store of storesRes.rows) {
      // Check latest scheduled job for today (UK date)
      const lastJobTodayRes = await db.query(
        `SELECT id, status, phase, created_at
         FROM ralawise_sync_jobs
         WHERE store_id = $1 AND trigger_source = 'scheduled' AND scheduled_for = $2
         ORDER BY id DESC LIMIT 1`,
        [store.id, ukDate]
      )
      const lastScheduledJobToday = lastJobTodayRes.rows[0] || null

      // Check active or paused job (prevent duplicate concurrent runs)
      const activeJob = await getActiveSyncJobForStore(db, store.id)

      const dueCheck = isScheduleDue({
        store,
        now: new Date(),
        lastScheduledJobToday,
        activeJob,
      })

      if (!dueCheck.isDue) {
        skipped.push({
          store_id: store.id,
          store_name: store.name,
          reason: dueCheck.reason,
        })
        continue
      }

      console.log(`[Scheduler Check] Store ${store.id} (${store.name}) is due for scheduled sync. Launching...`)

      // Execute headless sync for this store
      const syncResult = await runHeadlessSync(db, { store, vendorId: 1 })
      executed.push({
        store_id: store.id,
        store_name: store.name,
        result: syncResult,
      })
    }

    return NextResponse.json({
      ok: true,
      uk_date: ukDate,
      uk_time: `${String(ukTime.hour).padStart(2, '0')}:${String(ukTime.minute).padStart(2, '0')}`,
      global_enabled: true,
      stores_checked: storesRes.rows.length,
      executed,
      skipped,
    })
  } catch (err) {
    console.error('[Scheduler Check] Error running scheduled sync check:', err)
    return NextResponse.json(
      { ok: false, error: err.message || 'Scheduled sync check failed' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/ralawise/scheduled-sync/check
 * Diagnostic status check (read-only).
 */
export async function GET(request) {
  const auth = authenticateSchedulerRequest(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  }

  const globalEnabled = process.env.RALAWISE_SYNC_SCHEDULE_ENABLED === 'true'
  const ukDate = getUkDateString(new Date())
  const ukTime = getUkTimeComponents(new Date())

  return NextResponse.json({
    ok: true,
    global_enabled: globalEnabled,
    uk_date: ukDate,
    uk_time: `${String(ukTime.hour).padStart(2, '0')}:${String(ukTime.minute).padStart(2, '0')} (Europe/London)`,
    server_time_utc: new Date().toISOString(),
  })
}
