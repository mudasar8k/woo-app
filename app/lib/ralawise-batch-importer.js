/**
 * Modular chunk/batch importer for Ralawise -> Neon product synchronization.
 * Breaks execution into short, serverless-safe steps.
 */

const { parseCSV } = require('./csv-parser')
const {
  importProductRows,
  importVariationRows,
} = require('./csv-import')
const {
  fetchRalawiseCatalog,
  downloadCatalog,
} = require('./ralawise-client')
const {
  createCsvUploadRecord,
  finalizeCsvUpload,
  diffRows,
  retainLastImportFiles,
} = require('./ralawise-import')
const {
  JOB_STATUS,
  createSyncJob,
  updateSyncJob,
  getSyncJob,
  saveJobPayloads,
  getJobPayloads,
  getParentBatchSlice,
  getVariationBatchSlice,
  cleanupJobPayloads,
  serializeJob,
} = require('./ralawise-sync-jobs')

const DEFAULT_PARENT_BATCH_SIZE = 50
const DEFAULT_VARIATION_BATCH_SIZE = 25

/**
 * Phase 1: Prepare
 * Downloads & diffs supplier CSVs, creates sync job, saves batch payloads in DB.
 */
async function prepareRalawiseSync(arg1, arg2) {
  let db, storeId, vendorId, userId, files, triggerSource, scheduledFor, mockParentRows, mockVariationRows

  if (arg1 && typeof arg1.query === 'function') {
    db = arg1
    storeId = arg2?.storeId
    vendorId = arg2?.vendorId
    userId = arg2?.userId
    files = arg2?.files
    triggerSource = arg2?.triggerSource || 'manual'
    scheduledFor = arg2?.scheduledFor || null
    mockParentRows = arg2?.mockParentRows
    mockVariationRows = arg2?.mockVariationRows
  } else {
    db = arg1?.db
    storeId = arg1?.storeId
    vendorId = arg1?.vendorId
    userId = arg1?.userId
    files = arg1?.files
    triggerSource = arg1?.triggerSource || 'manual'
    scheduledFor = arg1?.scheduledFor || null
    mockParentRows = arg1?.mockParentRows
    mockVariationRows = arg1?.mockVariationRows
  }

  const job = await createSyncJob(db, {
    storeId,
    vendorId,
    userId,
    triggerSource,
    scheduledFor,
  })

  try {
    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.CONNECTING,
      step: JOB_STATUS.CONNECTING,
      message: 'Connecting to Ralawise...',
    })

    let productsText = null
    let variationsText = null
    let source = 'api'
    let productRows = null
    let variationRows = null

    if (mockParentRows && mockVariationRows) {
      productRows = mockParentRows
      variationRows = mockVariationRows
      productsText = JSON.stringify(mockParentRows)
      variationsText = JSON.stringify(mockVariationRows)
      source = 'mock'
    } else if (files?.parentCsvText && files?.variationsCsvText) {
      productsText = files.parentCsvText
      variationsText = files.variationsCsvText
      source = 'provided-files'
      productRows = await parseCSV(productsText)
      variationRows = await parseCSV(variationsText)
    } else {
      await updateSyncJob(db, job.id, {
        status: JOB_STATUS.DOWNLOADING,
        step: JOB_STATUS.DOWNLOADING,
        message: 'Downloading supplier catalogs...',
      })

      const catalog = await fetchRalawiseCatalog()
      productsText = catalog.parentCsvText
      variationsText = catalog.variationsCsvText
      source = catalog.source || 'api'
      productRows = await parseCSV(productsText)
      variationRows = await parseCSV(variationsText)
    }

    if (!productRows || !variationRows) {
      throw new Error('Failed to retrieve Ralawise catalog files')
    }

    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.DELTA,
      step: JOB_STATUS.DELTA,
      message: 'Comparing against previous import...',
    })

    let productRowsToImport = productRows
    let variationRowsToImport = variationRows
    let productsSkipped = 0
    let variationsSkipped = 0

    if (source !== 'mock') {
      const { lastImportPaths } = require('./ralawise-import')
      const fs = require('fs')
      const paths = lastImportPaths(vendorId)
      const lastParentText = fs.existsSync(paths.parentCsvPath)
        ? fs.readFileSync(paths.parentCsvPath, 'utf8')
        : null
      const lastVarText = fs.existsSync(paths.variationsCsvPath)
        ? fs.readFileSync(paths.variationsCsvPath, 'utf8')
        : null

      const lastProductRows = lastParentText ? await parseCSV(lastParentText) : null
      const lastVarRows = lastVarText ? await parseCSV(lastVarText) : null

      const productDiff = diffRows(productRows, lastProductRows, (row) => String(row.sku || row.code || '').trim())
      const variationDiff = diffRows(variationRows, lastVarRows, (row) => `${String(row.parent_sku || row.primary_sku || '').trim()}|${String(row.sku || '').trim()}`)

      productRowsToImport = productDiff.changedRows || []
      variationRowsToImport = variationDiff.changedRows || []
      productsSkipped = Number(productDiff.skipped) || 0
      variationsSkipped = Number(variationDiff.skipped) || 0

      const noChanges =
        !productDiff.fullImport &&
        productRowsToImport.length === 0 &&
        variationRowsToImport.length === 0

      if (noChanges) {
        retainLastImportFiles({
          vendorId,
          parentCsvText: productsText,
          variationsCsvText: variationsText,
        })

        await updateSyncJob(db, job.id, {
          status: JOB_STATUS.COMPLETED,
          step: JOB_STATUS.COMPLETED,
          phase: 'completed',
          message: 'No changes since last import',
          total_count: (productRows.length || 0) + (variationRows.length || 0),
          current_count: (productRows.length || 0) + (variationRows.length || 0),
          parent_total: 0,
          parent_processed: 0,
          variation_total: 0,
          variation_processed: 0,
          products_skipped: productsSkipped,
          variations_skipped: variationsSkipped,
          completed_at: new Date(),
        })

        return {
          ok: true,
          jobId: job.id,
          phase: 'completed',
          no_changes: true,
          parent_total: 0,
          variation_total: 0,
        }
      }
    }

    // Create tracking csv_uploads records
    const productUploadId = await createCsvUploadRecord({
      db,
      storeId,
      vendorId,
      userId,
      fileType: 'products',
      fileName: 'wordpressdatafullparent.csv',
      rowCount: productRowsToImport.length,
    })

    const variationUploadId = await createCsvUploadRecord({
      db,
      storeId,
      vendorId,
      userId,
      fileType: 'variations',
      fileName: 'wordpressdatafullvariations.csv',
      rowCount: variationRowsToImport.length,
    })

    // Save parsed payload in DB for safe stateless batch processing
    await saveJobPayloads(db, job.id, {
      parentRows: productRowsToImport,
      variationRows: variationRowsToImport,
      rawParentText: productsText,
      rawVarText: variationsText,
    })

    const initialPhase = productRowsToImport.length > 0 ? 'parents' : (variationRowsToImport.length > 0 ? 'variations' : 'finalize')
    const initialStep = initialPhase === 'parents' ? JOB_STATUS.IMPORTING_PRODUCTS : (initialPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE)

    const updated = await updateSyncJob(db, job.id, {
      status: initialStep,
      step: initialStep,
      phase: initialPhase,
      message: `Importing products... (0 / ${productRowsToImport.length})`,
      parent_total: productRowsToImport.length,
      parent_processed: 0,
      parent_cursor: 0,
      variation_total: variationRowsToImport.length,
      variation_processed: 0,
      variation_cursor: 0,
      total_count: productRowsToImport.length + variationRowsToImport.length,
      current_count: 0,
      products_skipped: productsSkipped,
      variations_skipped: variationsSkipped,
      csv_upload_parent_id: productUploadId,
      csv_upload_var_id: variationUploadId,
    })

    return {
      ok: true,
      jobId: job.id,
      phase: initialPhase,
      step: initialStep,
      parentTotal: productRowsToImport.length,
      variationTotal: variationRowsToImport.length,
      totalCount: productRowsToImport.length + variationRowsToImport.length,
      job: serializeJob(updated),
    }
  } catch (error) {
    console.error('Error preparing Ralawise sync:', error)
    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.FAILED,
      step: 'failed',
      error_message: error.message,
      completed_at: new Date(),
    })
    return { ok: false, error: error.message, jobId: job.id }
  }
}

/**
 * Phase 2: Process a single batch of parent products
 */
async function processParentBatch(db, jobId, { batchSize = DEFAULT_PARENT_BATCH_SIZE } = {}) {
  const job = await getSyncJob(db, jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  if (job.status === JOB_STATUS.PAUSED || job.cancel_requested) {
    return { ok: true, paused: true, job: serializeJob(job) }
  }

  const start = Number(job.parent_cursor) || 0
  const total = Number(job.parent_total) || 0
  const effectiveBatchSize = Math.max(1, parseInt(batchSize, 10) || DEFAULT_PARENT_BATCH_SIZE)

  if (start >= total) {
    const nextPhase = (Number(job.variation_total) || 0) > 0 ? 'variations' : 'finalize'
    const nextStep = nextPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE

    const updated = await updateSyncJob(db, jobId, {
      phase: nextPhase,
      step: nextStep,
      status: nextStep,
      message: nextPhase === 'variations'
        ? `Importing variations... (${job.variation_cursor || 0} / ${job.variation_total})`
        : 'Finalizing catalog sync...',
    })

    return {
      ok: true,
      hasMore: false,
      phase: nextPhase,
      job: serializeJob(updated),
    }
  }

  const slice = await getParentBatchSlice(db, jobId, start, effectiveBatchSize)
  const batchRows = slice?.rows || []

  if (batchRows.length === 0) {
    const nextPhase = (Number(job.variation_total) || 0) > 0 ? 'variations' : 'finalize'
    const nextStep = nextPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE

    const updated = await updateSyncJob(db, jobId, {
      phase: nextPhase,
      step: nextStep,
      status: nextStep,
      parent_cursor: total,
      parent_processed: total,
    })

    return {
      ok: true,
      hasMore: false,
      phase: nextPhase,
      job: serializeJob(updated),
    }
  }

  try {
    const result = await importProductRows({
      rows: batchRows,
      vendorId: job.vendor_id,
      csvUploadId: job.csv_upload_parent_id,
      db,
      rowOffset: start,
      batchSize: effectiveBatchSize,
      shouldContinue: async () => {
        const fresh = await getSyncJob(db, jobId)
        return fresh?.status !== JOB_STATUS.PAUSED && !fresh?.cancel_requested
      },
    })

    const newProcessed = start + batchRows.length
    const hasMore = newProcessed < total
    const nextPhase = hasMore ? 'parents' : ((Number(job.variation_total) || 0) > 0 ? 'variations' : 'finalize')
    const nextStep = hasMore ? JOB_STATUS.IMPORTING_PRODUCTS : (nextPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE)

    const updated = await updateSyncJob(db, jobId, {
      parent_cursor: newProcessed,
      parent_processed: newProcessed,
      current_count: newProcessed + (Number(job.variation_processed) || 0),
      products_new: (Number(job.products_new) || 0) + (Number(result.newCount) || 0),
      products_updated: (Number(job.products_updated) || 0) + (Number(result.updatedCount) || 0),
      products_errors: (Number(job.products_errors) || 0) + (Number(result.errors?.length) || 0),
      phase: nextPhase,
      step: nextStep,
      status: nextStep,
      message: hasMore
        ? `Importing products... (${newProcessed} / ${total})`
        : ((Number(job.variation_total) || 0) > 0
          ? `Importing variations... (${job.variation_cursor || 0} / ${job.variation_total})`
          : 'Finalizing catalog sync...'),
    })

    return {
      ok: true,
      hasMore,
      phase: nextPhase,
      batchSize: batchRows.length,
      job: serializeJob(updated),
    }
  } catch (error) {
    if (error?.code === 'SYNC_PAUSED' || /sync paused/i.test(error.message)) {
      const fresh = await getSyncJob(db, jobId)
      return { ok: true, paused: true, job: serializeJob(fresh) }
    }
    console.error(`Error processing parent batch for job ${jobId}:`, error)
    await updateSyncJob(db, jobId, {
      status: JOB_STATUS.PAUSED,
      error_message: error.message,
    })
    return { ok: false, error: error.message, jobId }
  }
}

/**
 * Phase 3: Process a single batch of variations
 */
async function processVariationBatch(db, jobId, { batchSize = DEFAULT_VARIATION_BATCH_SIZE } = {}) {
  const job = await getSyncJob(db, jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  if (job.status === JOB_STATUS.PAUSED || job.cancel_requested) {
    return { ok: true, paused: true, job: serializeJob(job) }
  }

  const start = Number(job.variation_cursor) || 0
  const total = Number(job.variation_total) || 0
  const effectiveBatchSize = Math.max(1, parseInt(batchSize, 10) || DEFAULT_VARIATION_BATCH_SIZE)

  if (start >= total) {
    const updated = await updateSyncJob(db, jobId, {
      phase: 'finalize',
      step: JOB_STATUS.FINALIZE,
      status: JOB_STATUS.FINALIZE,
      message: 'Finalizing catalog sync...',
    })

    return {
      ok: true,
      hasMore: false,
      phase: 'finalize',
      job: serializeJob(updated),
    }
  }

  const slice = await getVariationBatchSlice(db, jobId, start, effectiveBatchSize)
  const batchRows = slice?.rows || []

  if (batchRows.length === 0) {
    const updated = await updateSyncJob(db, jobId, {
      phase: 'finalize',
      step: JOB_STATUS.FINALIZE,
      status: JOB_STATUS.FINALIZE,
      variation_cursor: total,
      variation_processed: total,
    })

    return {
      ok: true,
      hasMore: false,
      phase: 'finalize',
      job: serializeJob(updated),
    }
  }

  try {
    const result = await importVariationRows({
      rows: batchRows,
      csvUploadId: job.csv_upload_var_id,
      db,
      rowOffset: start,
      batchSize: effectiveBatchSize,
      shouldContinue: async () => {
        const fresh = await getSyncJob(db, jobId)
        return fresh?.status !== JOB_STATUS.PAUSED && !fresh?.cancel_requested
      },
    })

    const newProcessed = start + batchRows.length
    const hasMore = newProcessed < total
    const nextPhase = hasMore ? 'variations' : 'finalize'
    const nextStep = hasMore ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE

    const updated = await updateSyncJob(db, jobId, {
      variation_cursor: newProcessed,
      variation_processed: newProcessed,
      current_count: (Number(job.parent_processed) || 0) + newProcessed,
      variations_new: (Number(job.variations_new) || 0) + (Number(result.newCount) || 0),
      variations_updated: (Number(job.variations_updated) || 0) + (Number(result.updatedCount) || 0),
      variations_errors: (Number(job.variations_errors) || 0) + (Number(result.errors?.length) || 0),
      phase: nextPhase,
      step: nextStep,
      status: nextStep,
      message: hasMore
        ? `Importing variations... (${newProcessed} / ${total})`
        : 'Finalizing catalog sync...',
    })

    return {
      ok: true,
      hasMore,
      phase: nextPhase,
      batchSize: batchRows.length,
      job: serializeJob(updated),
    }
  } catch (error) {
    if (error?.code === 'SYNC_PAUSED' || /sync paused/i.test(error.message)) {
      const fresh = await getSyncJob(db, jobId)
      return { ok: true, paused: true, job: serializeJob(fresh) }
    }
    console.error(`Error processing variation batch for job ${jobId}:`, error)
    await updateSyncJob(db, jobId, {
      status: JOB_STATUS.PAUSED,
      error_message: error.message,
    })
    return { ok: false, error: error.message, jobId }
  }
}

/**
 * Phase 4: Finalize
 */
async function finalizeRalawiseSync(db, jobId) {
  const job = await getSyncJob(db, jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  try {
    const payloads = await getJobPayloads(db, jobId)

    if (job.csv_upload_parent_id) {
      await finalizeCsvUpload(
        db,
        job.csv_upload_parent_id,
        Number(job.parent_processed) || 0,
        []
      )
    }

    if (job.csv_upload_var_id) {
      await finalizeCsvUpload(
        db,
        job.csv_upload_var_id,
        Number(job.variation_processed) || 0,
        []
      )
    }

    if (payloads?.rawParentText && payloads?.rawVarText) {
      retainLastImportFiles({
        vendorId: job.vendor_id,
        parentCsvText: payloads.rawParentText,
        variationsCsvText: payloads.rawVarText,
      })
    }

    await cleanupJobPayloads(db, jobId)

    const updated = await updateSyncJob(db, jobId, {
      status: JOB_STATUS.COMPLETED,
      step: JOB_STATUS.COMPLETED,
      phase: 'completed',
      message: 'Ralawise sync complete',
      completed_at: new Date(),
    })

    return {
      ok: true,
      status: JOB_STATUS.COMPLETED,
      job: serializeJob(updated),
    }
  } catch (error) {
    console.error(`Error finalizing Ralawise sync for job ${jobId}:`, error)
    await updateSyncJob(db, jobId, {
      status: JOB_STATUS.FAILED,
      error_message: error.message,
      completed_at: new Date(),
    })
    return { ok: false, error: error.message }
  }
}

/**
 * Stop / Pause a running sync job
 */
async function stopRalawiseSync(db, jobId) {
  const job = await getSyncJob(db, jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  const grandProcessed = (Number(job.parent_processed) || 0) + (Number(job.variation_processed) || 0)
  const grandTotal = (Number(job.parent_total) || 0) + (Number(job.variation_total) || 0)

  const updated = await updateSyncJob(db, jobId, {
    status: JOB_STATUS.PAUSED,
    cancel_requested: true,
    message: `Paused at ${grandProcessed.toLocaleString()} / ${grandTotal.toLocaleString()}. Click Resume to continue.`,
  })

  return {
    ok: true,
    status: JOB_STATUS.PAUSED,
    job: serializeJob(updated),
  }
}

/**
 * Resume a paused sync job
 */
async function resumeRalawiseSync(db, jobId) {
  const job = await getSyncJob(db, jobId)
  if (!job) return { ok: false, error: 'Job not found' }

  let resumePhase = job.phase || 'parents'
  const parentProcessed = Number(job.parent_processed) || 0
  const parentTotal = Number(job.parent_total) || 0
  const varProcessed = Number(job.variation_processed) || 0
  const varTotal = Number(job.variation_total) || 0

  if (parentProcessed < parentTotal) {
    resumePhase = 'parents'
  } else if (varProcessed < varTotal) {
    resumePhase = 'variations'
  } else {
    resumePhase = 'finalize'
  }

  const resumeStep =
    resumePhase === 'parents'
      ? JOB_STATUS.IMPORTING_PRODUCTS
      : resumePhase === 'variations'
        ? JOB_STATUS.IMPORTING_VARIATIONS
        : JOB_STATUS.FINALIZE

  const updated = await updateSyncJob(db, jobId, {
    status: resumeStep,
    step: resumeStep,
    phase: resumePhase,
    cancel_requested: false,
    message:
      resumePhase === 'parents'
        ? `Importing products... (${job.parent_cursor || 0} / ${parentTotal})`
        : resumePhase === 'variations'
          ? `Importing variations... (${job.variation_cursor || 0} / ${varTotal})`
          : 'Finalizing catalog sync...',
  })

  return {
    ok: true,
    status: resumeStep,
    phase: resumePhase,
    parentCursor: Number(updated.parent_cursor) || 0,
    variationCursor: Number(updated.variation_cursor) || 0,
    cancelRequested: false,
    job: serializeJob(updated),
  }
}

module.exports = {
  prepareRalawiseSync,
  processParentBatch,
  processVariationBatch,
  finalizeRalawiseSync,
  stopRalawiseSync,
  resumeRalawiseSync,
  DEFAULT_PARENT_BATCH_SIZE,
  DEFAULT_VARIATION_BATCH_SIZE,
}
