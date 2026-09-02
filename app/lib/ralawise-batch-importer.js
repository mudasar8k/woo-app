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
const DEFAULT_VARIATION_BATCH_SIZE = 150

/**
 * Phase 1: Prepare
 * Downloads & diffs supplier CSVs, creates sync job, saves batch payloads in DB.
 */
async function prepareRalawiseSync({ storeId, vendorId, userId, db, files = null }) {
  const job = await createSyncJob(db, { storeId, vendorId, userId })

  try {
    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.CONNECTING,
      step: JOB_STATUS.CONNECTING,
      message: 'Connecting to Ralawise...',
    })

    let productsText = null
    let variationsText = null
    let source = 'api'

    if (files?.parentCsvText && files?.variationsCsvText) {
      productsText = files.parentCsvText
      variationsText = files.variationsCsvText
      source = 'provided-files'
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
    }

    if (!productsText || !variationsText) {
      throw new Error('Failed to retrieve Ralawise catalog files')
    }

    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.DELTA,
      step: JOB_STATUS.DELTA,
      message: 'Comparing against previous import...',
    })

    const productRows = await parseCSV(productsText)
    const variationRows = await parseCSV(variationsText)

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

    const productRowsToImport = productDiff.changedRows || []
    const variationRowsToImport = variationDiff.changedRows || []
    const productsSkipped = Number(productDiff.skipped) || 0
    const variationsSkipped = Number(variationDiff.skipped) || 0

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
      total_count: Number(productRowsToImport.length + variationRowsToImport.length) || 0,
      current_count: 0,
      parent_total: Number(productRowsToImport.length) || 0,
      parent_processed: 0,
      parent_cursor: 0,
      variation_total: Number(variationRowsToImport.length) || 0,
      variation_processed: 0,
      variation_cursor: 0,
      products_skipped: productsSkipped,
      variations_skipped: variationsSkipped,
      csv_upload_parent_id: productUploadId,
      csv_upload_var_id: variationUploadId,
    })

    return {
      ok: true,
      jobId: job.id,
      phase: initialPhase,
      no_changes: false,
      parent_total: productRowsToImport.length,
      variation_total: variationRowsToImport.length,
      products_skipped: productsSkipped,
      variations_skipped: variationsSkipped,
      job: serializeJob(updated),
    }
  } catch (error) {
    console.error('Ralawise prepare failed:', error)
    await updateSyncJob(db, job.id, {
      status: JOB_STATUS.FAILED,
      message: error.message || 'Ralawise prepare failed',
      error_message: error.message || 'Ralawise prepare failed',
      completed_at: new Date(),
    })
    throw error
  }
}

/**
 * Phase 2: Process Parent Batch
 */
async function processParentBatch({ jobId, db, batchSize = DEFAULT_PARENT_BATCH_SIZE }) {
  const job = await getSyncJob(db, jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  if (job.cancel_requested || job.status === JOB_STATUS.PAUSED) {
    return { paused: true, job: serializeJob(job) }
  }

  const effectiveBatchSize = Math.max(1, Math.min(Number(batchSize) || DEFAULT_PARENT_BATCH_SIZE, 100))
  const start = Number(job.parent_cursor) || 0
  const payloadSlice = await getParentBatchSlice(db, jobId, start, effectiveBatchSize)
  if (!payloadSlice) throw new Error(`Job ${jobId} payloads not found`)

  const batchRows = payloadSlice.rows || []
  const total = Number(payloadSlice.total) || Number(job.parent_total) || 0

  if (start >= total || total === 0 || batchRows.length === 0) {
    const nextPhase = (Number(job.variation_total) || 0) > 0 ? 'variations' : 'finalize'
    const nextStep = nextPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE
    const updated = await updateSyncJob(db, jobId, {
      phase: nextPhase,
      step: nextStep,
      status: nextStep,
      message: nextPhase === 'variations'
        ? `Importing variations... (${Number(job.variation_processed) || 0} / ${Number(job.variation_total) || 0})`
        : 'Finalizing sync...',
    })
    if (job.csv_upload_parent_id) {
      await finalizeCsvUpload(db, job.csv_upload_parent_id, Number(job.parent_processed) || total, [])
    }
    return {
      ok: true,
      phase: nextPhase,
      parentProcessed: Number(job.parent_processed) || total,
      parentTotal: total,
      hasMore: false,
      job: serializeJob(updated),
    }
  }

  const end = Math.min(start + batchRows.length, total)

  const result = await importProductRows({
    rows: batchRows,
    vendorId: job.vendor_id,
    csvUploadId: job.csv_upload_parent_id,
    db,
    rowOffset: start,
    startIndex: 0,
    batchSize: effectiveBatchSize,
    initialNewCount: Number(job.products_new) || 0,
    initialUpdatedCount: Number(job.products_updated) || 0,
  })

  const newProcessed = start + (Number(result.processedCount) || batchRows.length)
  const isLastBatch = end >= total
  const nextPhase = isLastBatch ? ((Number(job.variation_total) || 0) > 0 ? 'variations' : 'finalize') : 'parents'
  const nextStep = isLastBatch
    ? (nextPhase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : JOB_STATUS.FINALIZE)
    : JOB_STATUS.IMPORTING_PRODUCTS

  const updated = await updateSyncJob(db, jobId, {
    phase: nextPhase,
    step: nextStep,
    status: nextStep,
    message: isLastBatch
      ? (nextPhase === 'variations' ? `Importing variations... (0 / ${job.variation_total})` : 'Finalizing sync...')
      : `Importing products... (${newProcessed} / ${total})`,
    parent_processed: newProcessed,
    parent_cursor: end,
    parent_total: total,
    products_new: (Number(job.products_new) || 0) + (Number(result.newCount) || 0),
    products_updated: (Number(job.products_updated) || 0) + (Number(result.updatedCount) || 0),
    products_errors: (Number(job.products_errors) || 0) + (Number(result.errors?.length) || 0),
    current_count: newProcessed + (Number(job.variation_processed) || 0),
  })

  if (isLastBatch && job.csv_upload_parent_id) {
    await finalizeCsvUpload(db, job.csv_upload_parent_id, newProcessed, result.errors || [])
  }

  return {
    ok: true,
    phase: nextPhase,
    parentProcessed: newProcessed,
    parentTotal: total,
    hasMore: !isLastBatch,
    batchCount: batchRows.length,
    job: serializeJob(updated),
  }
}

/**
 * Phase 3: Process Variation Batch
 */
async function processVariationBatch({ jobId, db, batchSize = DEFAULT_VARIATION_BATCH_SIZE }) {
  const job = await getSyncJob(db, jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  if (job.cancel_requested || job.status === JOB_STATUS.PAUSED) {
    return { paused: true, job: serializeJob(job) }
  }

  const effectiveBatchSize = Math.max(1, Math.min(Number(batchSize) || DEFAULT_VARIATION_BATCH_SIZE, 300))
  const start = Number(job.variation_cursor) || 0
  const payloadSlice = await getVariationBatchSlice(db, jobId, start, effectiveBatchSize)
  if (!payloadSlice) throw new Error(`Job ${jobId} payloads not found`)

  const batchRows = payloadSlice.rows || []
  const total = Number(payloadSlice.total) || Number(job.variation_total) || 0

  if (start >= total || total === 0 || batchRows.length === 0) {
    const updated = await updateSyncJob(db, jobId, {
      phase: 'finalize',
      step: JOB_STATUS.FINALIZE,
      status: JOB_STATUS.FINALIZE,
      message: 'Finalizing sync...',
    })
    if (job.csv_upload_var_id) {
      await finalizeCsvUpload(db, job.csv_upload_var_id, Number(job.variation_processed) || total, [])
    }
    return {
      ok: true,
      phase: 'finalize',
      variationProcessed: Number(job.variation_processed) || total,
      variationTotal: total,
      hasMore: false,
      job: serializeJob(updated),
    }
  }

  const end = Math.min(start + batchRows.length, total)

  const result = await importVariationRows({
    rows: batchRows,
    csvUploadId: job.csv_upload_var_id,
    db,
    rowOffset: start,
    startIndex: 0,
    batchSize: effectiveBatchSize,
    initialNewCount: Number(job.variations_new) || 0,
    initialUpdatedCount: Number(job.variations_updated) || 0,
  })

  const newProcessed = start + (Number(result.processedCount) || batchRows.length)
  const isLastBatch = end >= total
  const nextPhase = isLastBatch ? 'finalize' : 'variations'
  const nextStep = isLastBatch ? JOB_STATUS.FINALIZE : JOB_STATUS.IMPORTING_VARIATIONS

  const updated = await updateSyncJob(db, jobId, {
    phase: nextPhase,
    step: nextStep,
    status: nextStep,
    message: isLastBatch
      ? 'Finalizing sync...'
      : `Importing variations... (${newProcessed} / ${total})`,
    variation_processed: newProcessed,
    variation_cursor: end,
    variation_total: total,
    variations_new: (Number(job.variations_new) || 0) + (Number(result.newCount) || 0),
    variations_updated: (Number(job.variations_updated) || 0) + (Number(result.updatedCount) || 0),
    variations_errors: (Number(job.variations_errors) || 0) + (Number(result.errors?.length) || 0),
    current_count: (Number(job.parent_processed) || 0) + newProcessed,
  })

  if (isLastBatch && job.csv_upload_var_id) {
    await finalizeCsvUpload(db, job.csv_upload_var_id, newProcessed, result.errors || [])
  }

  return {
    ok: true,
    phase: nextPhase,
    variationProcessed: newProcessed,
    variationTotal: total,
    hasMore: !isLastBatch,
    batchCount: batchRows.length,
    job: serializeJob(updated),
  }
}

/**
 * Phase 4: Finalize
 */
async function finalizeRalawiseSync({ jobId, db }) {
  const job = await getSyncJob(db, jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  const payloads = await getJobPayloads(db, jobId)
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
    error_message: null,
  })

  return {
    ok: true,
    status: JOB_STATUS.COMPLETED,
    phase: 'completed',
    job: serializeJob(updated),
  }
}

/**
 * Resume a paused/cancelled sync job safely.
 * Clears cancel_requested, preserves existing cursors, repopulates payloads if missing.
 */
async function resumeRalawiseSync({ jobId, db, files = null }) {
  const job = await getSyncJob(db, jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  if (job.status === JOB_STATUS.COMPLETED) {
    throw new Error('Job is already completed')
  }

  let phase = job.phase || 'parents'
  let parentCursor = Number(job.parent_cursor) || 0
  let parentProcessed = Number(job.parent_processed) || 0
  let parentTotal = Number(job.parent_total) || 0
  let varCursor = Number(job.variation_cursor) || 0
  let varProcessed = Number(job.variation_processed) || 0
  let varTotal = Number(job.variation_total) || 0

  // Migrate state if legacy job paused without modern cursor columns populated
  if (parentCursor === 0 && Number(job.current_count) > 0 && job.step === 'importing_products') {
    parentCursor = Number(job.current_count)
    parentProcessed = Number(job.current_count)
    if (parentTotal === 0 && Number(job.total_count) > 0) {
      parentTotal = Number(job.total_count)
    }
    phase = 'parents'
  } else if (varCursor === 0 && Number(job.current_count) > 0 && job.step === 'importing_variations') {
    varCursor = Number(job.current_count)
    varProcessed = Number(job.current_count)
    phase = 'variations'
  }

  // Verify / repopulate payloads if missing
  let payloads = await getJobPayloads(db, jobId)
  if (!payloads?.hasParents || !payloads?.hasVars) {
    let parentCsvText = files?.parentCsvText
    let variationsCsvText = files?.variationsCsvText

    if (!parentCsvText || !variationsCsvText) {
      const catalog = await fetchRalawiseCatalog()
      parentCsvText = catalog.parentCsvText
      variationsCsvText = catalog.variationsCsvText
    }

    const productRows = await parseCSV(parentCsvText)
    const variationRows = await parseCSV(variationsCsvText)

    const { lastImportPaths } = require('./ralawise-import')
    const fs = require('fs')
    const paths = lastImportPaths(job.vendor_id)
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

    const productRowsToImport = productDiff.changedRows || []
    const variationRowsToImport = variationDiff.changedRows || []

    const effectiveParentRows = productRowsToImport.length > 0 ? productRowsToImport : productRows
    const effectiveVarRows = variationRowsToImport.length > 0 ? variationRowsToImport : variationRows

    await saveJobPayloads(db, jobId, {
      parentRows: effectiveParentRows,
      variationRows: effectiveVarRows,
      rawParentText: parentCsvText,
      rawVarText: variationsCsvText,
    })

    if (parentTotal === 0) parentTotal = effectiveParentRows.length
    if (varTotal === 0) varTotal = effectiveVarRows.length
  }

  if (phase === 'prepare') phase = 'parents'
  const nextStatus = phase === 'variations' ? JOB_STATUS.IMPORTING_VARIATIONS : (phase === 'finalize' ? JOB_STATUS.FINALIZE : JOB_STATUS.IMPORTING_PRODUCTS)
  const nextStep = nextStatus

  const updated = await updateSyncJob(db, jobId, {
    status: nextStatus,
    step: nextStep,
    phase,
    cancel_requested: false,
    parent_cursor: parentCursor,
    parent_processed: parentProcessed,
    parent_total: parentTotal,
    variation_cursor: varCursor,
    variation_processed: varProcessed,
    variation_total: varTotal,
    message: `Resuming at ${parentProcessed} / ${parentTotal}...`,
    error_message: null,
  })

  return serializeJob(updated)
}

module.exports = {
  prepareRalawiseSync,
  processParentBatch,
  processVariationBatch,
  finalizeRalawiseSync,
  resumeRalawiseSync,
  DEFAULT_PARENT_BATCH_SIZE,
  DEFAULT_VARIATION_BATCH_SIZE,
}
