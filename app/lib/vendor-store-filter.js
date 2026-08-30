/**
 * SQL helpers for scoping products to vendors assigned to a store.
 * Expects store_id as query parameter $1 when using VENDOR_STORE_JOIN.
 */
const VENDOR_STORE_JOIN =
  'INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1'

function vendorStoreFilterClause(storeIdPlaceholder = '$1') {
  return `EXISTS (
    SELECT 1 FROM vendor_stores vs
    WHERE vs.vendor_id = p.vendor_id AND vs.store_id = ${storeIdPlaceholder}
  )`
}

module.exports = {
  VENDOR_STORE_JOIN,
  vendorStoreFilterClause,
}
