const db = require('./db')

/**
 * Assign all active vendors to a store so its products become visible.
 * Safe to call multiple times (uses ON CONFLICT DO NOTHING).
 */
async function assignAllVendorsToStore(storeId) {
  const result = await db.query(
    `INSERT INTO vendor_stores (vendor_id, store_id)
     SELECT id, $1 FROM vendors WHERE status = 'active'
     ON CONFLICT (vendor_id, store_id) DO NOTHING
     RETURNING id`,
    [storeId]
  )

  return result.rowCount
}

module.exports = {
  assignAllVendorsToStore,
}
