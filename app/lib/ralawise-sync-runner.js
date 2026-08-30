/**
 * Shared worker that runs (or resumes) a Ralawise sync job.
 */
const { runRalawiseImport } = require('./ralawise-import')
const {
  JOB_STATUS,
  updateSyncJob,
  getSyncJob,
  makeJobProgressUpdater,
  isSyncPausedError,
} = require('./ralawise-sync-jobs')

async function runSyncJobWorker(db, job, { resume = false } = {}) {
  const onProgress = makeJobProgressUpdater(db, job.id)
  const shouldContinue = async () => {
    const current = await getSyncJob(db, job.id)
    return current?.status !== JOB_STATUS.PAUSED
  }

  try {
    const fresh = await getSyncJob(db, job.id)
    const resumeFromStep = resume ? fresh?.step : null
    const resumeOffset = resume ? fresh?.current_count || 0 : 0

    if (resume) {
      await updateSyncJob(db, job.id, {
        status: resumeFromStep || JOB_STATUS.CONNECTING,
        message: `Resuming from ${resumeFromStep || 'start'}…`,
        error_message: null,
        completed_at: null,
      })
    } else {
      await updateSyncJob(db, job.id, {
        status: JOB_STATUS.CONNECTING,
        step: JOB_STATUS.CONNECTING,
        message: 'Starting Ralawise sync…',
        started_at: new Date(),
      })
    }

    const result = await runRalawiseImport({
      storeId: job.store_id,
      vendorId: job.vendor_id,
      userId: job.initiated_by,
      db,
      onProgress,
      shouldContinue,
      resumeFromStep:
        resumeFromStep === JOB_STATUS.IMPORTING_PRODUCTS ||
        resumeFromStep === JOB_STATUS.IMPORTING_VARIATIONS
          ? resumeFromStep
          : null,
      resumeOffset,
      initialProductCounters: resume
        ? {
            new: fresh?.products_new || 0,
            updated: fresh?.products_updated || 0,
          }
        : null,
      initialVariationCounters: resume
        ? {
            new: fresh?.variations_new || 0,
            updated: fresh?.variations_updated || 0,
          }
        : null,
    })

    // If user paused during the run, keep paused (don't overwrite with completed)
    const after = await getSyncJob(db, job.id)
    if (after?.status === JOB_STATUS.PAUSED) {
      return { paused: true }
    }

    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.COMPLETED,
      step: JOB_STATUS.COMPLETED,
      message: result.no_changes
        ? 'No changes since last import'
        : 'Ralawise sync complete',
      current_count:
        (result.products?.processed ?? 0) + (result.variations?.processed ?? 0),
      total_count:
        (result.products?.totalRows ?? 0) + (result.variations?.totalRows ?? 0),
      products_new: result.products?.new ?? 0,
      products_updated: result.products?.updated ?? 0,
      products_skipped: result.products?.skipped ?? 0,
      products_errors: result.products?.errorCount ?? 0,
      variations_new: result.variations?.new ?? 0,
      variations_updated: result.variations?.updated ?? 0,
      variations_skipped: result.variations?.skipped ?? 0,
      variations_errors: result.variations?.errorCount ?? 0,
      result_json: result,
      completed_at: new Date(),
      error_message: null,
    })

    return { completed: true, result }
  } catch (error) {
    if (isSyncPausedError(error)) {
      const current = await getSyncJob(db, job.id)
      await updateSyncJob(db, job.id, {
        status: JOB_STATUS.PAUSED,
        // keep step where we were
        step: current?.step || JOB_STATUS.PAUSED,
        message:
          current?.message && !/paused/i.test(current.message)
            ? `Paused at ${current.message}`
            : `Paused at ${current?.current_count || 0} / ${current?.total_count || 0}`,
        error_message: null,
      })
      return { paused: true }
    }

    console.error('Ralawise sync job failed:', error)
    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.FAILED,
      message: error.message || 'Ralawise sync failed',
      error_message: error.message || 'Ralawise sync failed',
      completed_at: new Date(),
    })
    return { failed: true, error }
  }
}

module.exports = {
  runSyncJobWorker,
}
