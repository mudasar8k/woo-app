/**
 * Ralawise Automatic Scheduled Sync Engine
 * Handles UK DST-aware scheduling, duplicate protection, headless execution, and notifications.
 */

const {
  prepareRalawiseSync,
  processParentBatch,
  processVariationBatch,
  finalizeRalawiseSync,
  DEFAULT_PARENT_BATCH_SIZE,
  DEFAULT_VARIATION_BATCH_SIZE,
} = require('./ralawise-batch-importer')
const {
  JOB_STATUS,
  getActiveSyncJobForStore,
  getSyncJob,
  updateSyncJob,
  ensureJobsTable,
} = require('./ralawise-sync-jobs')
const {
  sendSyncCompletionEmail,
  sendSyncFailureEmail,
} = require('./ralawise-notifications')

/**
 * Get current date string in UK timezone (Europe/London): YYYY-MM-DD
 */
function getUkDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

/**
 * Get current hour and minute in UK timezone (Europe/London): { hour, minute }
 */
function getUkTimeComponents(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10)
  return { hour, minute }
}

/**
 * Parse configured time string "HH:mm" into { hour, minute }
 */
function parseTimeSetting(timeStr = '14:00') {
  const [h, m] = String(timeStr || '14:00')
    .split(':')
    .map((v) => parseInt(v, 10))
  return {
    hour: isNaN(h) ? 14 : Math.min(23, Math.max(0, h)),
    minute: isNaN(m) ? 0 : Math.min(59, Math.max(0, m)),
  }
}

/**
 * Check if the scheduled sync is due to run for a given store.
 *
 * @param {object} store - Store database record
 * @param {Date} now - Current time
 * @param {object} lastScheduledJob - Latest scheduled job for today if any
 * @param {object} activeJob - Active/paused job if any
 * @param {boolean} force - Force mode (bypasses due time only)
 * @returns {{ isDue: boolean, reason: string }}
 */
function isScheduleDue({ store, now = new Date(), lastScheduledJobToday = null, activeJob = null, force = false }) {
  // 1. Global Feature Flag Check (NEVER bypassed)
  const globalEnabled = process.env.RALAWISE_SYNC_SCHEDULE_ENABLED === 'true'
  if (!globalEnabled) {
    return { isDue: false, reason: 'Global feature flag RALAWISE_SYNC_SCHEDULE_ENABLED is false' }
  }

  // 2. Store Level Setting Check (NEVER bypassed)
  if (!store?.ralawise_auto_sync_enabled) {
    return { isDue: false, reason: `Automatic sync is disabled for Store ${store?.id || ''}` }
  }

  // 3. Duplicate Active Job Check (NEVER bypassed - prevents concurrent runs)
  if (activeJob) {
    return {
      isDue: false,
      reason: `Active job #${activeJob.id} already exists in status '${activeJob.status}'`,
      activeJobId: activeJob.id,
    }
  }

  // 4. One Run Per UK Calendar Date Check (bypassed if force=true for controlled QA testing)
  if (lastScheduledJobToday && !force) {
    return {
      isDue: false,
      reason: `Scheduled sync already ran for UK date ${getUkDateString(now)} (Job #${lastScheduledJobToday.id})`,
    }
  }

  // 5. Configured Time vs Current UK Time Check (bypassed if force=true)
  if (!force) {
    const currentUk = getUkTimeComponents(now)
    const targetTime = parseTimeSetting(store.ralawise_sync_time || '14:00')

    const currentMinutes = currentUk.hour * 60 + currentUk.minute
    const targetMinutes = targetTime.hour * 60 + targetTime.minute

    if (currentMinutes < targetMinutes) {
      return {
        isDue: false,
        reason: `Scheduled time (${String(targetTime.hour).padStart(2, '0')}:${String(targetTime.minute).padStart(2, '0')} UK) has not been reached yet (current UK time: ${String(currentUk.hour).padStart(2, '0')}:${String(currentUk.minute).padStart(2, '0')})`,
      }
    }
  }

  return {
    isDue: true,
    reason: force ? 'Forced execution via workflow_dispatch' : 'Scheduled time reached and all safety conditions met',
  }
}

/**
 * Headless execution loop for a scheduled sync job.
 * Executes prepare -> parent batches -> variation batches -> finalize sequentially with transient retries.
 */
async function runHeadlessSync(db, { store, vendorId = 1, batchParentSize = DEFAULT_PARENT_BATCH_SIZE, batchVarSize = DEFAULT_VARIATION_BATCH_SIZE }) {
  const storeId = store.id
  const ukDate = getUkDateString(new Date())

  console.log(`[Headless Sync] Starting scheduled sync for Store ${storeId} (${store.name || ''})...`)

  // Step 1: Prepare
  const prep = await prepareRalawiseSync(db, {
    storeId,
    vendorId,
    userId: null,
    triggerSource: 'scheduled',
    scheduledFor: ukDate,
  })

  if (!prep.ok) {
    console.error(`[Headless Sync] Prepare phase failed for Store ${storeId}:`, prep.error)
    await db.query(
      `UPDATE stores SET last_scheduled_sync_at = CURRENT_TIMESTAMP, last_scheduled_sync_status = 'failed', last_scheduled_sync_message = $1 WHERE id = $2`,
      [prep.error || 'Prepare phase failed', storeId]
    ).catch(() => {})

    if (prep.jobId) {
      const failedJob = await getSyncJob(db, prep.jobId)
      await sendSyncFailureEmail(db, { store, job: failedJob, error: new Error(prep.error) })
    }
    return { ok: false, error: prep.error, phase: 'prepare' }
  }

  const jobId = prep.jobId

  // If no delta changes since last import, prepare completes immediately
  if (prep.no_changes) {
    console.log(`[Headless Sync] Job #${jobId} completed in prepare: No changes since last import.`)
    await db.query(
      `UPDATE stores SET last_scheduled_sync_at = CURRENT_TIMESTAMP, last_scheduled_sync_status = 'completed', last_scheduled_sync_message = 'No changes since last import' WHERE id = $1`,
      [storeId]
    ).catch(() => {})

    const completedJob = await getSyncJob(db, jobId)
    await sendSyncCompletionEmail(db, { store, job: completedJob })
    return { ok: true, jobId, no_changes: true, phase: 'completed' }
  }

  // Step 2: Parent Batches
  let hasMoreParents = prep.parentTotal > 0
  while (hasMoreParents) {
    let attempts = 0
    let batchRes = null
    while (attempts < 3) {
      attempts++
      try {
        batchRes = await processParentBatch(db, jobId, { batchSize: batchParentSize })
        if (batchRes.ok) break
      } catch (err) {
        console.warn(`[Headless Sync] Parent batch attempt ${attempts} failed:`, err.message)
      }
      await new Promise((r) => setTimeout(r, attempts * 1000))
    }

    if (!batchRes || !batchRes.ok) {
      console.error(`[Headless Sync] Parent batch exhausted retries for Job #${jobId}`)
      const job = await getSyncJob(db, jobId)
      await sendSyncFailureEmail(db, { store, job, error: new Error(batchRes?.error || 'Parent batch failed') })
      return { ok: false, error: batchRes?.error, jobId, phase: 'parents' }
    }

    if (batchRes.paused) {
      console.warn(`[Headless Sync] Job #${jobId} was paused.`)
      return { ok: true, paused: true, jobId, phase: 'parents' }
    }

    hasMoreParents = Boolean(batchRes.hasMore)
  }

  // Step 3: Variation Batches
  let hasMoreVars = (prep.variationTotal || 0) > 0
  while (hasMoreVars) {
    let attempts = 0
    let batchRes = null
    while (attempts < 3) {
      attempts++
      try {
        batchRes = await processVariationBatch(db, jobId, { batchSize: batchVarSize })
        if (batchRes.ok) break
      } catch (err) {
        console.warn(`[Headless Sync] Variation batch attempt ${attempts} failed:`, err.message)
      }
      await new Promise((r) => setTimeout(r, attempts * 1000))
    }

    if (!batchRes || !batchRes.ok) {
      console.error(`[Headless Sync] Variation batch exhausted retries for Job #${jobId}`)
      const job = await getSyncJob(db, jobId)
      await sendSyncFailureEmail(db, { store, job, error: new Error(batchRes?.error || 'Variation batch failed') })
      return { ok: false, error: batchRes?.error, jobId, phase: 'variations' }
    }

    if (batchRes.paused) {
      console.warn(`[Headless Sync] Job #${jobId} was paused.`)
      return { ok: true, paused: true, jobId, phase: 'variations' }
    }

    hasMoreVars = Boolean(batchRes.hasMore)
  }

  // Step 4: Finalize
  const finRes = await finalizeRalawiseSync(db, jobId)
  if (!finRes.ok) {
    console.error(`[Headless Sync] Finalize failed for Job #${jobId}:`, finRes.error)
    const job = await getSyncJob(db, jobId)
    await sendSyncFailureEmail(db, { store, job, error: new Error(finRes.error) })
    return { ok: false, error: finRes.error, jobId, phase: 'finalize' }
  }

  // Update store observability status
  await db.query(
    `UPDATE stores SET last_scheduled_sync_at = CURRENT_TIMESTAMP, last_scheduled_sync_status = 'completed', last_scheduled_sync_message = 'Sync completed successfully' WHERE id = $1`,
    [storeId]
  ).catch(() => {})

  // Dispatch Completion Email Notification (Idempotent)
  const completedJob = await getSyncJob(db, jobId)
  await sendSyncCompletionEmail(db, { store, job: completedJob })

  console.log(`[Headless Sync] Scheduled sync for Store ${storeId} finished successfully. Job #${jobId}`)
  return { ok: true, status: 'completed', jobId }
}

module.exports = {
  getUkDateString,
  getUkTimeComponents,
  parseTimeSetting,
  isScheduleDue,
  runHeadlessSync,
}
