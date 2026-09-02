const {
  validateProductRow,
  validateVariationRow,
  parseProductRow,
  parseVariationRow,
} = require('./csv-parser')
const { createVendorCache, resolveVendorId } = require('./vendor-resolver')

const DEFAULT_BATCH_SIZE = 50

class ImportPausedError extends Error {
  constructor(message = 'Sync paused') {
    super(message)
    this.name = 'ImportPausedError'
    this.code = 'SYNC_PAUSED'
  }
}

/**
 * Upsert product rows by SKU with bulk-prefetched lookups for serverless performance.
 *
 * @returns {{ processedCount: number, newCount: number, updatedCount: number, errors: string[], paused?: boolean }}
 */
async function importProductRows({
  rows,
  vendorId,
  csvUploadId,
  db,
  rowOffset = 0,
  batchSize = DEFAULT_BATCH_SIZE,
  vendorCache = null,
  onProgress = null,
  startIndex = 0,
  initialNewCount = 0,
  initialUpdatedCount = 0,
  shouldContinue = null,
}) {
  const errors = []
  let processedCount = 0
  let newCount = initialNewCount
  let updatedCount = initialUpdatedCount
  const cache = vendorCache || createVendorCache()
  const defaultVendorId = parseInt(vendorId, 10)
  const total = rows.length
  const beginAt = Math.max(0, Math.min(startIndex || 0, rows.length))

  for (let batchStart = beginAt; batchStart < rows.length; batchStart += batchSize) {
    if (typeof shouldContinue === 'function') {
      const ok = await shouldContinue()
      if (!ok) {
        throw new ImportPausedError('Sync paused')
      }
    }

    const batchEnd = Math.min(batchStart + batchSize, rows.length)
    const currentBatchSlice = rows.slice(batchStart, batchEnd)

    // Pre-fetch all existing product IDs for this batch in a single query (eliminates N+1 selects)
    const batchSkus = currentBatchSlice
      .map((r) => String(r.sku || r.code || r.Code || '').trim())
      .filter(Boolean)

    const skuToIdMap = new Map()
    if (batchSkus.length > 0) {
      const existingRes = await db.query(
        'SELECT id, sku FROM products WHERE sku = ANY($1::text[])',
        [batchSkus]
      )
      for (const row of existingRes.rows) {
        skuToIdMap.set(String(row.sku).trim(), row.id)
      }
    }

    for (let i = batchStart; i < batchEnd; i++) {
      const globalRowIndex = rowOffset + i
      try {
        const row = rows[i]
        const validationErrors = validateProductRow(row, globalRowIndex)
        if (validationErrors.length > 0) {
          errors.push(...validationErrors)
          continue
        }

        const productData = parseProductRow(row)
        const resolvedVendorId = await resolveVendorId({
          row,
          defaultVendorId,
          vendorCache: cache,
          db,
        })

        const trimmedSku = String(productData.sku).trim()
        const existingId = skuToIdMap.get(trimmedSku)

        if (existingId) {
          await db.query(
            `UPDATE products SET
              csv_upload_id = $1, vendor_id = $2, name = $3, description = $4, short_description = $5,
              price = $6, regular_price = $7, sale_price = $8, stock_quantity = $9,
              manage_stock = $10, stock_status = $11, categories = $12, tags = $13,
              images = $14, attributes = $15, brand = $16, fabric = $17, weight = $18,
              size_description = $19, length_fit = $20, updated_at = NOW()
             WHERE id = $21`,
            [
              csvUploadId,
              resolvedVendorId,
              productData.name,
              productData.description,
              productData.short_description,
              productData.price,
              productData.regular_price,
              productData.sale_price,
              productData.stock_quantity,
              productData.manage_stock,
              productData.stock_status,
              productData.categories,
              productData.tags,
              productData.images,
              productData.attributes,
              productData.brand,
              productData.fabric,
              productData.weight,
              productData.size_description,
              productData.length_fit,
              existingId,
            ]
          )
          updatedCount++
        } else {
          const insertRes = await db.query(
            `INSERT INTO products (
              csv_upload_id, vendor_id, sku, name, description, short_description,
              price, regular_price, sale_price, stock_quantity, manage_stock,
              stock_status, categories, tags, images, attributes, brand,
              fabric, weight, size_description, length_fit
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
            RETURNING id`,
            [
              csvUploadId,
              resolvedVendorId,
              productData.sku,
              productData.name,
              productData.description,
              productData.short_description,
              productData.price,
              productData.regular_price,
              productData.sale_price,
              productData.stock_quantity,
              productData.manage_stock,
              productData.stock_status,
              productData.categories,
              productData.tags,
              productData.images,
              productData.attributes,
              productData.brand,
              productData.fabric,
              productData.weight,
              productData.size_description,
              productData.length_fit,
            ]
          )
          if (insertRes.rows.length > 0) {
            skuToIdMap.set(trimmedSku, insertRes.rows[0].id)
          }
          newCount++
        }
        processedCount++
      } catch (rowError) {
        if (rowError?.code === 'SYNC_PAUSED') throw rowError
        console.error(`Error processing product row ${globalRowIndex + 1}:`, rowError.message)
        errors.push(`Row ${globalRowIndex + 1}: ${rowError.message}`)
      }
    }

    if (typeof onProgress === 'function') {
      await onProgress({
        current: batchEnd,
        total,
        newCount,
        updatedCount,
        errorCount: errors.length,
      })
    }
  }

  return { processedCount, newCount, updatedCount, errors }
}

/**
 * Fast bulk-upsert variation rows by (parent product, sku) in a single atomic SQL statement.
 *
 * @returns {{ processedCount: number, newCount: number, updatedCount: number, errors: string[] }}
 */
async function importVariationRows({
  rows,
  csvUploadId,
  db,
  rowOffset = 0,
  batchSize = DEFAULT_BATCH_SIZE,
  onProgress = null,
  startIndex = 0,
  initialNewCount = 0,
  initialUpdatedCount = 0,
  shouldContinue = null,
}) {
  const errors = []
  let newCount = initialNewCount
  let updatedCount = initialUpdatedCount
  let processedCount = 0
  const total = rows.length
  const beginAt = Math.max(0, Math.min(startIndex || 0, rows.length))

  for (let batchStart = beginAt; batchStart < rows.length; batchStart += batchSize) {
    if (typeof shouldContinue === 'function') {
      const ok = await shouldContinue()
      if (!ok) {
        throw new ImportPausedError('Sync paused')
      }
    }

    const batchEnd = Math.min(batchStart + batchSize, rows.length)
    const currentBatchSlice = rows.slice(batchStart, batchEnd)

    // Validate rows in memory
    const validItems = []
    for (let i = 0; i < currentBatchSlice.length; i++) {
      const globalRowIndex = rowOffset + batchStart + i
      const row = currentBatchSlice[i]
      const validationErrors = validateVariationRow(row, globalRowIndex)
      if (validationErrors.length > 0) {
        errors.push(...validationErrors)
        continue
      }
      const variationData = parseVariationRow(row)
      validItems.push({ variationData, globalRowIndex })
    }

    if (validItems.length === 0) {
      continue
    }

    // Bulk pre-fetch parent product IDs (1 query)
    const parentSkus = [
      ...new Set(
        validItems
          .map((item) => String(item.variationData.parent_sku || '').trim())
          .filter(Boolean)
      ),
    ]

    const parentSkuToIdMap = new Map()
    if (parentSkus.length > 0) {
      const parentRes = await db.query(
        'SELECT id, sku FROM products WHERE sku = ANY($1::text[])',
        [parentSkus]
      )
      for (const row of parentRes.rows) {
        parentSkuToIdMap.set(String(row.sku).trim(), row.id)
      }
    }

    // Build multi-row parameterized values for single-statement bulk upsert
    const valueClauses = []
    const values = []
    let paramIdx = 1

    for (const item of validItems) {
      const data = item.variationData
      const parentSku = String(data.parent_sku).trim()
      const productId = parentSkuToIdMap.get(parentSku)

      if (!productId) {
        errors.push(
          `Row ${item.globalRowIndex + 1}: Parent product with SKU "${data.parent_sku}" not found`
        )
        continue
      }

      const imageVal =
        data.image ||
        (data.images ? String(data.images).split(',')[0]?.trim() : null) ||
        null
      const imagesVal = data.images || data.image || null

      valueClauses.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, $${paramIdx + 10}, $${paramIdx + 11}, $${paramIdx + 12}, $${paramIdx + 13}, $${paramIdx + 14}, $${paramIdx + 15}, 'pending')`
      )

      values.push(
        productId,
        csvUploadId || null,
        data.parent_sku,
        data.sku,
        data.attributes,
        data.size,
        data.color,
        data.price,
        data.regular_price,
        data.sale_price,
        data.stock_quantity,
        data.manage_stock,
        data.stock_status,
        imageVal,
        data.tax_class,
        imagesVal
      )

      paramIdx += 16
    }

    if (valueClauses.length > 0) {
      const sql = `
        INSERT INTO product_variations (
          product_id, csv_upload_id, parent_sku, sku, attributes, size, color,
          price, regular_price, sale_price, stock_quantity, manage_stock,
          stock_status, image, tax_class, images, status
        )
        VALUES ${valueClauses.join(', ')}
        ON CONFLICT (product_id, sku)
        DO UPDATE SET
          csv_upload_id = COALESCE(EXCLUDED.csv_upload_id, product_variations.csv_upload_id),
          parent_sku = EXCLUDED.parent_sku,
          attributes = EXCLUDED.attributes,
          size = EXCLUDED.size,
          color = EXCLUDED.color,
          price = EXCLUDED.price,
          regular_price = EXCLUDED.regular_price,
          sale_price = EXCLUDED.sale_price,
          stock_quantity = EXCLUDED.stock_quantity,
          manage_stock = EXCLUDED.manage_stock,
          stock_status = EXCLUDED.stock_status,
          image = EXCLUDED.image,
          tax_class = EXCLUDED.tax_class,
          images = EXCLUDED.images,
          updated_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `

      const upsertRes = await db.query(sql, values)
      const inserted = upsertRes.rows.filter((r) => r.is_insert).length
      const updated = upsertRes.rows.filter((r) => !r.is_insert).length

      newCount += inserted
      updatedCount += updated
      processedCount += upsertRes.rows.length
    }

    if (typeof onProgress === 'function') {
      await onProgress({
        current: batchEnd,
        total,
        newCount,
        updatedCount,
        errorCount: errors.length,
      })
    }
  }

  return { processedCount, newCount, updatedCount, errors }
}

module.exports = {
  importProductRows,
  importVariationRows,
  DEFAULT_BATCH_SIZE,
  ImportPausedError,
}
