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
 */
async function createCsvUploadRecord({
  db,
  storeId,
  vendorId,
  userId,
  fileType,
  fileName,
  rowCount,
}) {
  const result = await db.query(
    `INSERT INTO csv_uploads (store_id, vendor_id, uploaded_by, file_type, file_name, row_count, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing')
     RETURNING id`,
    [storeId, vendorId, userId, fileType, fileName, rowCount]
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

function rowHash(row) {
  const keys = Object.keys(row || {}).sort()
  const normalized = {}
  for (const key of keys) {
    const value = row[key]
    normalized[key] = value == null ? '' : String(value).trim()
  }
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function productKey(row) {
  return String(row.sku || '').trim()
}

function variationKey(row) {
  return `${String(row.parent_sku || '').trim()}|${String(row.sku || '').trim()}`
}

/**
 * Compare new rows against last-import baseline. Returns only changed/new rows.
 */
function diffRows(newRows, lastRows, keyFn) {
  if (!lastRows || lastRows.length === 0) {
    return {
      changedRows: newRows,
      skipped: 0,
      changed: newRows.length,
      fullImport: true,
    }
  }

  const lastMap = new Map()
  for (const row of lastRows) {
    const key = keyFn(row)
    if (!key || key === '|') continue
    lastMap.set(key, rowHash(row))
  }

  const changedRows = []
  let skipped = 0

  for (const row of newRows) {
    const key = keyFn(row)
    if (!key || key === '|') {
      changedRows.push(row)
      continue
    }
    const hash = rowHash(row)
    const prev = lastMap.get(key)
    if (prev === hash) {
      skipped++
    } else {
      changedRows.push(row)
    }
  }

  return {
    changedRows,
    skipped,
    changed: changedRows.length,
    fullImport: false,
  }
}

function retainLastImportFiles({ vendorId, parentCsvText, variationsCsvText }) {
  const { dir, parentCsvPath, variationsCsvPath } = lastImportPaths(vendorId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(parentCsvPath, parentCsvText, 'utf8')
  fs.writeFileSync(variationsCsvPath, variationsCsvText, 'utf8')
}

async function loadLastImportRows(vendorId) {
  const { parentCsvPath, variationsCsvPath } = lastImportPaths(vendorId)
  if (!fs.existsSync(parentCsvPath) || !fs.existsSync(variationsCsvPath)) {
    return { products: null, variations: null }
  }
  try {
    const parentText = fs.readFileSync(parentCsvPath, 'utf8')
    const variationsText = fs.readFileSync(variationsCsvPath, 'utf8')
    return {
      products: await parseCSV(parentText),
      variations: await parseCSV(variationsText),
    }
  } catch (error) {
    console.warn('Failed to read last Ralawise import baseline:', error.message)
    return { products: null, variations: null }
  }
}

/**
 * Download (or use provided CSV text), delta-filter vs last import, then upsert.
 * Supports resume via resumeFromStep + resumeOffset (row index within that step).
 */
async function runRalawiseImport({
  storeId,
  vendorId,
  userId,
  db,
  urls = null,
  parentCsvText = null,
  variationsCsvText = null,
  maxProductRows = null,
  maxVariationRows = null,
  workDir = null,
  forcePlaywright = false,
  onProgress = null,
  shouldContinue = null,
  resumeFromStep = null,
  resumeOffset = 0,
  initialProductCounters = null,
  initialVariationCounters = null,
}) {
  let productUploadId = null
  let variationUploadId = null
  let catalog = null

  const checkContinue = async () => {
    if (typeof shouldContinue === 'function') {
      const ok = await shouldContinue()
      if (!ok) throw new ImportPausedError('Sync paused')
    }
  }

  try {
    let productsText = parentCsvText
    let variationsText = variationsCsvText

    if (!productsText || !variationsText) {
      if (urls?._catalog?.parentCsvText && urls?._catalog?.variationsCsvText) {
        await reportProgress(onProgress, {
          step: 'connecting',
          message: 'Using pre-fetched Ralawise catalog…',
        })
        catalog = urls._catalog
        productsText = catalog.parentCsvText
        variationsText = catalog.variationsCsvText
      } else if (urls?.parentUrl && urls?.variationsUrl && urls.source === 'env') {
        catalog = await downloadCatalog({
          parentUrl: urls.parentUrl,
          variationsUrl: urls.variationsUrl,
          workDir: workDir || getRalawiseWorkDir('import'),
          onProgress,
        })
        productsText = catalog.parentCsvText
        variationsText = catalog.variationsCsvText
      } else {
        catalog = await fetchRalawiseCatalog({
          workDir: workDir || getRalawiseWorkDir('import'),
          forcePlaywright,
          onProgress,
        })
        productsText = catalog.parentCsvText
        variationsText = catalog.variationsCsvText
      }
    }

    await checkContinue()

    await reportProgress(onProgress, {
      step: 'delta',
      message: 'Comparing to last import…',
      current: 0,
      total: 0,
    })

    let productRows = await parseCSV(productsText)
    let variationRows = await parseCSV(variationsText)

    if (maxProductRows != null) {
      productRows = productRows.slice(0, maxProductRows)
    }
    if (maxVariationRows != null) {
      variationRows = variationRows.slice(0, maxVariationRows)
    }

    const last = await loadLastImportRows(vendorId)
    const productDiff = diffRows(productRows, last.products, productKey)
    const variationDiff = diffRows(variationRows, last.variations, variationKey)

    const productsSkipped = productDiff.skipped
    const variationsSkipped = variationDiff.skipped
    const productRowsToImport = productDiff.changedRows
    const variationRowsToImport = variationDiff.changedRows

    const deltaMessage = productDiff.fullImport
      ? 'No previous import — full catalog'
      : `Delta: ${productDiff.changed} products + ${variationDiff.changed} variations changed (${productsSkipped + variationsSkipped} unchanged skipped)`

    await reportProgress(onProgress, {
      step: 'delta',
      message: deltaMessage,
      current: productDiff.changed + variationDiff.changed,
      total: productRows.length + variationRows.length,
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
      })

      await reportProgress(onProgress, {
        step: 'importing_products',
        message: `Importing products… (${productStartIndex} / ${productRowsToImport.length})`,
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
              message: `Importing products… (${p.current} / ${p.total})`,
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
    })

    await reportProgress(onProgress, {
      step: 'importing_variations',
      message: `Importing variations… (${variationStartIndex} / ${variationRowsToImport.length})`,
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
                message: `Importing variations… (${p.current} / ${p.total})`,
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
