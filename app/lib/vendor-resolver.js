/**
 * Resolve vendor_id for a product row during CSV upload.
 * CSV column value takes precedence; falls back to the upload form vendor.
 */

function extractVendorFromRow(row) {
  const raw =
    row.vendor ||
    row.vendor_name ||
    row.supplier ||
    row.attributepa_vendor ||
    row.attributevendor ||
    row.pa_vendor ||
    null

  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  return trimmed === '' ? null : trimmed
}

function createVendorCache() {
  return new Map()
}

async function resolveVendorId({ row, defaultVendorId, vendorCache, db }) {
  const csvValue = extractVendorFromRow(row)

  if (!csvValue) {
    return defaultVendorId
  }

  const cacheKey = csvValue.toLowerCase()
  if (vendorCache.has(cacheKey)) {
    return vendorCache.get(cacheKey)
  }

  if (/^\d+$/.test(csvValue)) {
    const byId = await db.query(
      'SELECT id FROM vendors WHERE id = $1 AND status = $2 LIMIT 1',
      [parseInt(csvValue, 10), 'active']
    )
    if (byId.rows.length > 0) {
      vendorCache.set(cacheKey, byId.rows[0].id)
      return byId.rows[0].id
    }
    throw new Error(
      `Vendor ID "${csvValue}" not found. Add the vendor in Super Admin first.`
    )
  }

  const byName = await db.query(
    `SELECT id FROM vendors
     WHERE LOWER(TRIM(name)) = LOWER($1) AND status = $2
     LIMIT 1`,
    [csvValue, 'active']
  )

  if (byName.rows.length > 0) {
    vendorCache.set(cacheKey, byName.rows[0].id)
    return byName.rows[0].id
  }

  throw new Error(
    `Vendor "${csvValue}" not found. Add the vendor in Super Admin first.`
  )
}

module.exports = {
  extractVendorFromRow,
  createVendorCache,
  resolveVendorId,
}
