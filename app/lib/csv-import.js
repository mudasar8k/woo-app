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
 * Upsert product rows by SKU.
 * New products keep DB default status (pending). Updates preserve existing status.
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

        const existing = await db.query(
          'SELECT id FROM products WHERE sku = $1 LIMIT 1',
          [productData.sku]
        )

        if (existing.rows.length > 0) {
          const productId = existing.rows[0].id
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
              productId,
            ]
          )
          updatedCount++
        } else {
          await db.query(
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
 * Upsert variation rows by (parent product, sku).
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
  let processedCount = 0
  let newCount = initialNewCount
  let updatedCount = initialUpdatedCount
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

    for (let i = batchStart; i < batchEnd; i++) {
      const globalRowIndex = rowOffset + i
      try {
        const row = rows[i]
        const validationErrors = validateVariationRow(row, globalRowIndex)
        if (validationErrors.length > 0) {
          errors.push(...validationErrors)
          continue
        }

        const variationData = parseVariationRow(row)

        const productResult = await db.query(
          'SELECT id FROM products WHERE sku = $1 LIMIT 1',
          [variationData.parent_sku]
        )

        if (productResult.rows.length === 0) {
          errors.push(
            `Row ${globalRowIndex + 1}: Parent product with SKU "${variationData.parent_sku}" not found`
          )
          continue
        }

        const productId = productResult.rows[0].id
        const existingVar = await db.query(
          'SELECT id FROM product_variations WHERE product_id = $1 AND sku = $2 LIMIT 1',
          [productId, variationData.sku]
        )

        const imagesVal = variationData.images || variationData.image || null
        const imageVal =
          variationData.image ||
          (variationData.images
            ? String(variationData.images).split(',')[0]?.trim()
            : null) ||
          null

        if (existingVar.rows.length > 0) {
          await db.query(
            `UPDATE product_variations SET
              csv_upload_id = $1, parent_sku = $2, attributes = $3, size = $4, color = $5, price = $6,
              regular_price = $7, sale_price = $8, stock_quantity = $9,
              manage_stock = $10, stock_status = $11, image = $12, tax_class = $13,
              images = $14, updated_at = NOW()
             WHERE id = $15`,
            [
              csvUploadId,
              variationData.parent_sku,
              variationData.attributes,
              variationData.size,
              variationData.color,
              variationData.price,
              variationData.regular_price,
              variationData.sale_price,
              variationData.stock_quantity,
              variationData.manage_stock,
              variationData.stock_status,
              imageVal,
              variationData.tax_class,
              imagesVal,
              existingVar.rows[0].id,
            ]
          )
          updatedCount++
        } else {
          await db.query(
            `INSERT INTO product_variations (
              product_id, csv_upload_id, parent_sku, sku, attributes, size, color,
              price, regular_price, sale_price, stock_quantity, manage_stock,
              stock_status, image, tax_class, images, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')`,
            [
              productId,
              csvUploadId,
              variationData.parent_sku,
              variationData.sku,
              variationData.attributes,
              variationData.size,
              variationData.color,
              variationData.price,
              variationData.regular_price,
              variationData.sale_price,
              variationData.stock_quantity,
              variationData.manage_stock,
              variationData.stock_status,
              imageVal,
              variationData.tax_class,
              imagesVal,
            ]
          )
          newCount++
        }
        processedCount++
      } catch (rowError) {
        if (rowError?.code === 'SYNC_PAUSED') throw rowError
        console.error(`Error processing variation row ${globalRowIndex + 1}:`, rowError.message)
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

module.exports = {
  importProductRows,
  importVariationRows,
  DEFAULT_BATCH_SIZE,
  ImportPausedError,
}
