/**
 * Smoke test for Ralawise import orchestration using local small CSVs.
 *
 * Usage:
 *   node scripts/ralawise-import-smoke.js
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { Pool } = require('pg')
const {
  runRalawiseImport,
  readCsvFile,
} = require('../app/lib/ralawise-import')
const { parseCSV } = require('../app/lib/csv-parser')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
})

const db = {
  query: (text, params) => pool.query(text, params),
}

async function main() {
  const storeId = parseInt(process.env.RALAWISE_TEST_STORE_ID || '4', 10)
  const vendorId = parseInt(
    process.env.RALAWISE_DEFAULT_VENDOR_ID ||
      process.env.RALAWISE_TEST_VENDOR_ID ||
      '1',
    10
  )
  const userId = parseInt(process.env.RALAWISE_TEST_USER_ID || '1', 10)

  const parentPath = path.join(
    __dirname,
    '../wordpressdatafullparent/wordpressdatafullparent-small.csv'
  )
  let parentCsvText = readCsvFile(parentPath)

  // Build a tiny variations CSV from first parent SKUs in the small file
  const parents = await parseCSV(parentCsvText)
  if (parents.length === 0) throw new Error('Small parent CSV is empty')

  const parentSku = parents[0].sku
  const variationsCsvText = [
    '"parent_sku","sku","stock_status",regular_price,"tax_class","images","meta:attribute_Colour","meta:attribute_Size"',
    `"${parentSku}","${parentSku}-TEST-S","instock",10,"standard","","Black","S"`,
    `"${parentSku}","${parentSku}-TEST-M","instock",10,"standard","","Black","M"`,
    `"MISSING-PARENT","MISSING-PARENT-S","instock",10,"standard","","Black","S"`,
  ].join('\n')

  console.log(`Importing ${parents.length} products + 3 variation rows (1 orphan expected)…`)

  const first = await runRalawiseImport({
    storeId,
    vendorId,
    userId,
    db,
    parentCsvText,
    variationsCsvText,
  })

  console.log('First run products:', first.products)
  console.log('First run variations:', first.variations)

  if (first.products.processed < 1) {
    throw new Error('Expected at least one product processed')
  }
  if (first.variations.errorCount < 1) {
    throw new Error('Expected orphan variation error for MISSING-PARENT')
  }

  const pending = await db.query(
    `SELECT status FROM products WHERE sku = $1 LIMIT 1`,
    [parentSku]
  )
  // May already be approved from prior imports; only assert row exists
  if (pending.rows.length === 0) {
    throw new Error(`Product ${parentSku} not found after import`)
  }
  console.log(`SKU ${parentSku} status:`, pending.rows[0].status)

  const second = await runRalawiseImport({
    storeId,
    vendorId,
    userId,
    db,
    parentCsvText,
    variationsCsvText,
  })

  console.log('Second run products:', second.products)
  console.log('Second run variations:', second.variations)

  if (second.products.updated < 1 && second.products.new > 0) {
    throw new Error('Second run should update existing products, not only insert new')
  }
  if (second.products.updated < first.products.processed && second.products.new !== 0) {
    // Allow if some failed; primary check:
  }
  if (second.products.updated < 1) {
    throw new Error('Second run expected updatedCount >= 1')
  }
  if (second.variations.updated < 1) {
    throw new Error('Second run expected variation updatedCount >= 1')
  }

  console.log('Import smoke test OK')
}

main()
  .catch((err) => {
    console.error('Import smoke FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
