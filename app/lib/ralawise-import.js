const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { parseCSV } = require('./csv-parser')
const {
  importProductRows,
  importVariationRows,
  ImportPausedError,
} = require('./csv-import')
const {
  fetchRalawiseCatalog,
  downloadCatalog,
  PARENT_CSV_NAME,
  VARIATIONS_CSV_NAME,
  getRalawiseTempRoot,
  getRalawiseWorkDir,
} = require('./ralawise-client')

async function reportProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    await onProgress(payload)
  }
}

/**
 * Create a csv_uploads row and return its id.
 * Supports both manual admin uploads and scheduled/system imports.
 */
async function createCsvUploadRecord({
  db,
  storeId,
  vendorId,
  userId = null,
  fileType,
  fileName,
  rowCount,
  triggerSource = 'manual',
}) {
  await db.query(`ALTER TABLE csv_uploads ALTER COLUMN uploaded_by DROP NOT NULL`).catch(() => {})
  await db.query(`ALTER TABLE csv_uploads ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(20) DEFAULT 'manual'`).catch(() => {})

  const source = triggerSource || (userId ? 'manual' : 'scheduled')
  const result = await db.query(
    `INSERT INTO csv_uploads (store_id, vendor_id, uploaded_by, file_type, file_name, row_count, status, trigger_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
     RETURNING id`,
    [storeId, vendorId, userId || null, fileType, fileName, rowCount, source]
  )
  return result.rows[0].id
}

async function finalizeCsvUpload(db, csvUploadId, processedCount, errors) {
  await db.query(
    `UPDATE csv_uploads
     SET status = 'completed',
         row_count = $1,
         processed_row_count = $1,
         error_message = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [
      processedCount,
      errors.length > 0 ? errors.slice(0, 50).join('\n') : null,
      csvUploadId,
    ]
  )
}

async function failCsvUpload(db, csvUploadId, message) {
  if (!csvUploadId) return
  await db.query(
    `UPDATE csv_uploads
     SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [message, csvUploadId]
  )
}

function lastImportDir(vendorId) {
  return path.join(getRalawiseTempRoot(), 'last', `vendor-${vendorId}`)
}

function lastImportPaths(vendorId) {
  const dir = lastImportDir(vendorId)
  return {
    dir,
    parentCsvPath: path.join(dir, PARENT_CSV_NAME),
    variationsCsvPath: path.join(dir, VARIATIONS_CSV_NAME),
  }
}

function computeFileHash(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex')
}

function retainLastImportFiles({ vendorId, parentCsvText, variationsCsvText }) {
  try {
    const { dir, parentCsvPath, variationsCsvPath } = lastImportPaths(vendorId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(parentCsvPath, parentCsvText, 'utf8')
    fs.writeFileSync(variationsCsvPath, variationsCsvText, 'utf8')
  } catch (err) {
    console.warn(`Could not retain baseline CSVs for vendor ${vendorId}: ${err.message}`)
  }
}

function diffRows(currentRows, lastRows, keyFn) {
  if (!lastRows || lastRows.length === 0) {
    return {
      changedRows: currentRows,
      fullImport: true,
      skipped: 0,
      total: currentRows.length,
    }
  }

  const lastMap = new Map()
  for (const r of lastRows) {
    const k = keyFn(r)
    if (k) lastMap.set(k, JSON.stringify(r))
  }

  const changed = []
  let skipped = 0
  for (const r of currentRows) {
    const k = keyFn(r)
    const curStr = JSON.stringify(r)
    const prevStr = lastMap.get(k)
    if (!prevStr || prevStr !== curStr) {
      changed.push(r)
    } else {
      skipped++
    }
  }

  return {
    changedRows: changed,
    fullImport: false,
    skipped,
    total: currentRows.length,
  }
}

async function runRalawiseImport({
  urls,
  storeId,
  vendorId,
  userId = null,
  db,
  onProgress,
  shouldContinue,
  resumeFromStep,
  resumeOffset,
  initialProductCounters,
  initialVariationCounters,
  triggerSource = 'manual',
}) {
  let productUploadId = null
  let variationUploadId = null

  async function checkContinue() {
    if (typeof shouldContinue === 'function') {
      const ok = await shouldContinue()
      if (!ok) {
        throw new ImportPausedError('Import paused by user')
      }
    }
  }

  try {
    await reportProgress(onProgress, {
      step: 'downloading',
      message: 'Downloading supplier catalogs...',
    })
    await checkContinue()

    let catalog = null
    let productsText = null
    let variationsText = null

    if (urls?.parentCsvText && urls?.variationsCsvText) {
      productsText = urls.parentCsvText
      variationsText = urls.variationsCsvText
    } else {
      catalog = await fetchRalawiseCatalog()
      productsText = catalog.parentCsvText
      variationsText = catalog.variationsCsvText
    }

    if (!productsText || !variationsText) {
      throw new Error('Failed to download Ralawise catalog files')
    }

    await reportProgress(onProgress, {
      step: 'delta',
      message: 'Comparing against previous import...',
    })
    await checkContinue()

    const productRows = await parseCSV(productsText)
    const variationRows = await parseCSV(variationsText)

    const paths = lastImportPaths(vendorId)
    const lastParentText = fs.existsSync(paths.parentCsvPath)
      ? fs.readFileSync(paths.parentCsvPath, 'utf8')
      : null
    const lastVarText = fs.existsSync(paths.variationsCsvPath)
      ? fs.readFileSync(paths.variationsCsvPath, 'utf8')
      : null

    const lastProductRows = lastParentText ? await parseCSV(lastParentText) : null
    const lastVarRows = lastVarText ? await parseCSV(lastVarText) : null

    const productDiff = diffRows(
      productRows,
      lastProductRows,
      (row) => String(row.sku || row.code || '').trim()
    )
    const variationDiff = diffRows(
      variationRows,
      lastVarRows,
      (row) =>
        `${String(row.parent_sku || row.primary_sku || '').trim()}|${String(row.sku || '').trim()}`
    )

    const productRowsToImport = productDiff.changedRows || []
    const variationRowsToImport = variationDiff.changedRows || []
    const productsSkipped = Number(productDiff.skipped) || 0
    const variationsSkipped = Number(variationDiff.skipped) || 0

    await reportProgress(onProgress, {
      step: 'delta',
      message: `Delta check: ${productRowsToImport.length} products to import (${productsSkipped} skipped), ${variationRowsToImport.length} variations to import (${variationsSkipped} skipped).`,
      products_skipped: productsSkipped,
      variations_skipped: variationsSkipped,
    })

    await checkContinue()

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

      return {
        ok: true,
        workDir: catalog?.workDir || null,
        source: catalog?.source || urls?.source || 'provided-csv',
        delta: true,
        no_changes: true,
        csv_upload_ids: { products: null, variations: null },
        products: {
          totalRows: productRows.length,
          processed: 0,
          new: 0,
          updated: 0,
          skipped: productsSkipped,
          errors: [],
          errorCount: 0,
        },
        variations: {
          totalRows: variationRows.length,
          processed: 0,
          new: 0,
          updated: 0,
          skipped: variationsSkipped,
          errors: [],
          errorCount: 0,
        },
        downloaded_at: new Date().toISOString(),
      }
    }

    const skipProducts = resumeFromStep === 'importing_variations'
    const productStartIndex =
      resumeFromStep === 'importing_products' ? Math.max(0, resumeOffset || 0) : 0
    const variationStartIndex =
      resumeFromStep === 'importing_variations' ? Math.max(0, resumeOffset || 0) : 0

    let productResult = {
      processedCount: 0,
      newCount: initialProductCounters?.new ?? 0,
      updatedCount: initialProductCounters?.updated ?? 0,
      errors: [],
    }

    if (!skipProducts) {
      productUploadId = await createCsvUploadRecord({
        db,
        storeId,
        vendorId,
        userId,
        fileType: 'products',
        fileName: 'wordpressdatafullparent.csv',
        rowCount: productRowsToImport.length,
        triggerSource,
      })

      await reportProgress(onProgress, {
        step: 'importing_products',
        message: `Importing products... (${productStartIndex} / ${productRowsToImport.length})`,
        current: productStartIndex,
        total: productRowsToImport.length,
        products_skipped: productsSkipped,
        variations_skipped: variationsSkipped,
        products_new: productResult.newCount,
        products_updated: productResult.updatedCount,
      })

      console.log(
        `Ralawise import: ${productRowsToImport.length} products to upsert ` +
          `(start ${productStartIndex}; ${productsSkipped} skipped; upload #${productUploadId})`
      )

      if (productRowsToImport.length > 0) {
        productResult = await importProductRows({
          rows: productRowsToImport,
          vendorId,
          csvUploadId: productUploadId,
          db,
          startIndex: productStartIndex,
          initialNewCount: productResult.newCount,
          initialUpdatedCount: productResult.updatedCount,
          shouldContinue,
          onProgress: async (p) => {
            await reportProgress(onProgress, {
              step: 'importing_products',
              message: `Importing products... (${p.current} / ${p.total})`,
              current: p.current,
              total: p.total,
              newCount: p.newCount,
              updatedCount: p.updatedCount,
              products_skipped: productsSkipped,
              variations_skipped: variationsSkipped,
            })
          },
        })
      }

      await finalizeCsvUpload(
        db,
        productUploadId,
        productResult.processedCount + productStartIndex,
        productResult.errors
      )
    }

    variationUploadId = await createCsvUploadRecord({
      db,
      storeId,
      vendorId,
      userId,
      fileType: 'variations',
      fileName: 'wordpressdatafullvariations.csv',
      rowCount: variationRowsToImport.length,
      triggerSource,
    })

    await reportProgress(onProgress, {
      step: 'importing_variations',
      message: `Importing variations... (${variationStartIndex} / ${variationRowsToImport.length})`,
      current: variationStartIndex,
      total: variationRowsToImport.length,
      products_new: productResult.newCount,
      products_updated: productResult.updatedCount,
      products_errors: productResult.errors.length,
      products_skipped: productsSkipped,
      variations_skipped: variationsSkipped,
      variations_new: initialVariationCounters?.new ?? 0,
      variations_updated: initialVariationCounters?.updated ?? 0,
    })

    console.log(
      `Ralawise import: ${variationRowsToImport.length} variations to upsert ` +
        `(start ${variationStartIndex}; ${variationsSkipped} skipped; upload #${variationUploadId})`
    )

    const variationResult =
      variationRowsToImport.length > 0
        ? await importVariationRows({
            rows: variationRowsToImport,
            csvUploadId: variationUploadId,
            db,
            startIndex: variationStartIndex,
            initialNewCount: initialVariationCounters?.new ?? 0,
            initialUpdatedCount: initialVariationCounters?.updated ?? 0,
            shouldContinue,
            onProgress: async (p) => {
              await reportProgress(onProgress, {
                step: 'importing_variations',
                message: `Importing variations... (${p.current} / ${p.total})`,
                current: p.current,
                total: p.total,
                newCount: p.newCount,
                updatedCount: p.updatedCount,
                products_new: productResult.newCount,
                products_updated: productResult.updatedCount,
                products_errors: productResult.errors.length,
                products_skipped: productsSkipped,
                variations_skipped: variationsSkipped,
              })
            },
          })
        : {
            processedCount: 0,
            newCount: initialVariationCounters?.new ?? 0,
            updatedCount: initialVariationCounters?.updated ?? 0,
            errors: [],
          }

    await finalizeCsvUpload(
      db,
      variationUploadId,
      variationResult.processedCount + variationStartIndex,
      variationResult.errors
    )

    retainLastImportFiles({
      vendorId,
      parentCsvText: productsText,
      variationsCsvText: variationsText,
    })

    return {
      ok: true,
      workDir: catalog?.workDir || null,
      source: catalog?.source || urls?.source || 'provided-csv',
      delta: !productDiff.fullImport,
      no_changes: false,
      csv_upload_ids: {
        products: productUploadId,
        variations: variationUploadId,
      },
      products: {
        totalRows: productRows.length,
        processed: productResult.processedCount + (skipProducts ? 0 : productStartIndex),
        new: productResult.newCount,
        updated: productResult.updatedCount,
        skipped: productsSkipped,
        errors: productResult.errors.slice(0, 100),
        errorCount: productResult.errors.length,
      },
      variations: {
        totalRows: variationRows.length,
        processed: variationResult.processedCount + variationStartIndex,
        new: variationResult.newCount,
        updated: variationResult.updatedCount,
        skipped: variationsSkipped,
        errors: variationResult.errors.slice(0, 100),
        errorCount: variationResult.errors.length,
      },
      downloaded_at: new Date().toISOString(),
    }
  } catch (error) {
    if (error?.code === 'SYNC_PAUSED' || error?.name === 'ImportPausedError') {
      throw error
    }
    await failCsvUpload(db, productUploadId, error.message)
    await failCsvUpload(db, variationUploadId, error.message)
    throw error
  }
}

function readCsvFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

module.exports = {
  runRalawiseImport,
  readCsvFile,
  createCsvUploadRecord,
  finalizeCsvUpload,
  diffRows,
  lastImportPaths,
  retainLastImportFiles,
}
