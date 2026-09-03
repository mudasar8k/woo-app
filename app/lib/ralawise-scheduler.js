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
 * @returns {{ isDue: boolean, reason: string }}
 */
function isScheduleDue({ store, now = new Date(), lastScheduledJobToday = null, activeJob = null }) {
  // 1. Global Feature Flag Check
  const globalEnabled = process.env.RALAWISE_SYNC_SCHEDULE_ENABLED === 'true'
  if (!globalEnabled) {
    return { isDue: false, reason: 'Global feature flag RALAWISE_SYNC_SCHEDULE_ENABLED is false' }
  }

  // 2. Store Level Setting Check
  if (!store?.ralawise_auto_sync_enabled) {
    return { isDue: false, reason: `Automatic sync is disabled for Store ${store?.id || ''}` }
  }

  // 3. Duplicate Active Job Check
  if (activeJob) {
    return {
      isDue: false,
      reason: `Active job #${activeJob.id} already exists in status '${activeJob.status}'`,
      activeJobId: activeJob.id,
    }
  }

  // 4. One Run Per UK Calendar Date Check
  if (lastScheduledJobToday) {
    return {
      isDue: false,
      reason: `Scheduled sync already ran for UK date ${getUkDateString(now)} (Job #${lastScheduledJobToday.id})`,
    }
  }

  // 5. Configured Time vs Current UK Time Check
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

  return { isDue: true, reason: 'Scheduled sync is due' }
}

/**
 * Headless executor that runs Ralawise sync batches to completion sequentially.
 */
async function runHeadlessSync(db, { store, vendorId = 1, jobId = null }) {
  await ensureJobsTable(db)
  const ukDate = getUkDateString(new Date())

  let currentJobId = jobId
  let startingPhase = 'parents'

  // 1. If no jobId provided, initialize prepare phase
  if (!currentJobId) {
    console.log(`[Scheduler] Initializing prepare phase for Store ${store.id}...`)
    const prep = await prepareRalawiseSync(db, {
      storeId: store.id,
      vendorId: vendorId || 1,
      userId: null,
      triggerSource: 'scheduled',
      scheduledFor: ukDate,
    })

    if (!prep.ok) {
      console.error(`[Scheduler] Prepare failed for Store ${store.id}:`, prep.error)
      await updateStoreScheduledStatus(db, store.id, {
        status: 'failed',
        message: prep.error || 'Prepare phase failed',
      })
      return { ok: false, error: prep.error }
    }

    currentJobId = prep.jobId

    if (prep.phase === 'completed' || prep.no_changes) {
      console.log(`[Scheduler] No changes detected for Store ${store.id}. Finalized.`)
      await updateStoreScheduledStatus(db, store.id, {
        status: 'completed',
        message: 'Completed with zero changes (delta matched)',
      })
      const finalJob = await getSyncJob(db, currentJobId)
      await sendSyncCompletionEmail(db, { store, job: finalJob })
      return { ok: true, jobId: currentJobId, no_changes: true }
    }

    startingPhase = prep.phase || 'parents'
  } else {
    const existing = await getSyncJob(db, currentJobId)
    startingPhase = existing?.phase || 'parents'
  }

  console.log(`[Scheduler] Starting headless batch processing for Job #${currentJobId} (Phase: ${startingPhase})...`)

  try {
    let currentPhase = startingPhase

    // 2. Parent Product Batches (50/batch)
    while (currentPhase === 'parents') {
      const res = await processParentBatch(db, currentJobId, {
        batchSize: DEFAULT_PARENT_BATCH_SIZE,
      })

      if (!res.ok) {
        throw new Error(res.error || 'Parent batch failed')
      }

      if (res.paused || res.job?.status === 'paused') {
        console.log(`[Scheduler] Job #${currentJobId} was paused.`)
        await updateStoreScheduledStatus(db, store.id, {
          status: 'paused',
          message: 'Paused during parent product import',
        })
        await sendSyncFailureEmail(db, { store, job: res.job, error: new Error('Job was paused') })
        return { ok: false, paused: true, jobId: currentJobId }
      }

      currentPhase = res.phase
    }

    // 3. Variation Batches (25/batch)
    while (currentPhase === 'variations') {
      const res = await processVariationBatch(db, currentJobId, {
        batchSize: DEFAULT_VARIATION_BATCH_SIZE,
      })

      if (!res.ok) {
        throw new Error(res.error || 'Variation batch failed')
      }

      if (res.paused || res.job?.status === 'paused') {
        console.log(`[Scheduler] Job #${currentJobId} was paused.`)
        await updateStoreScheduledStatus(db, store.id, {
          status: 'paused',
          message: 'Paused during variation import',
        })
        await sendSyncFailureEmail(db, { store, job: res.job, error: new Error('Job was paused') })
        return { ok: false, paused: true, jobId: currentJobId }
      }

      currentPhase = res.phase
    }

    // 4. Finalize
    if (currentPhase === 'finalize') {
      const fin = await finalizeRalawiseSync(db, currentJobId)
      if (!fin.ok) {
        throw new Error(fin.error || 'Finalize failed')
      }

      console.log(`[Scheduler] Job #${currentJobId} finalized successfully!`)
      await updateStoreScheduledStatus(db, store.id, {
        status: 'completed',
        message: 'Ralawise sync completed successfully',
      })

      const finalJob = await getSyncJob(db, currentJobId)
      await sendSyncCompletionEmail(db, { store, job: finalJob })
      return { ok: true, jobId: currentJobId, job: finalJob }
    }

    return { ok: true, jobId: currentJobId }
  } catch (err) {
    console.error(`[Scheduler] Headless execution failed for Job #${currentJobId}:`, err.message)
    const failedJob = await updateSyncJob(db, currentJobId, {
      status: JOB_STATUS.PAUSED,
      error_message: err.message,
    })

    await updateStoreScheduledStatus(db, store.id, {
      status: 'failed',
      message: err.message,
    })

    await sendSyncFailureEmail(db, { store, job: failedJob, error: err })
    return { ok: false, error: err.message, jobId: currentJobId }
  }
}

/**
 * Update store's last scheduled sync status metadata.
 */
async function updateStoreScheduledStatus(db, storeId, { status, message }) {
  await db.query(
    `UPDATE stores SET
       last_scheduled_sync_at = CURRENT_TIMESTAMP,
       last_scheduled_sync_status = $1,
       last_scheduled_sync_message = $2
     WHERE id = $3`,
    [status, message || null, storeId]
  ).catch((err) => {
    console.warn('[Scheduler] Could not update store scheduled status:', err.message)
  })
}

module.exports = {
  getUkDateString,
  getUkTimeComponents,
  parseTimeSetting,
  isScheduleDue,
  runHeadlessSync,
  updateStoreScheduledStatus,
}
