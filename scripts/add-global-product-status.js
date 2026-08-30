// Migration: reintroduces a GLOBAL review status on `products`, moving the
// approval gate off the per-store `product_stores` table. Previously a
// product only exported to a store once someone approved it for that exact
// store_id (see migrate-product-store-links.js, which deliberately dropped
// these same columns from `products` in favor of per-store rows) - that
// model means every newly created store starts with an empty catalog even
// though the same products were already reviewed for an existing store.
// Going forward, `product_stores` is used purely for per-store sync
// bookkeeping (woo_product_id / last-synced marker); its own status/review
// columns are left in place untouched but become inert history.
//
// Safe to re-run: column/index creation uses IF NOT EXISTS, and the
// backfill only touches rows where status IS NULL (i.e. rows added by this
// migration's own ALTER TABLE, before this script has backfilled them).

const { Pool } = require('pg')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

function backupDatabase() {
  const backupDir = path.join(__dirname, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(backupDir, `pre-global-product-status-migration-${timestamp}.sql`)

  console.log(`Backing up products/product_stores to ${backupFile} ...`)
  const pgDumpBin = process.env.PG_DUMP_BIN || 'pg_dump'
  execFileSync(
    pgDumpBin,
    [
      process.env.DATABASE_URL,
      '-t', 'products',
      '-t', 'product_stores',
      '--no-owner',
      '--no-privileges',
      '-f', backupFile,
    ],
    // A dropped connection to Neon can otherwise leave pg_dump hanging
    // indefinitely on a dead socket read with no output and no error.
    { stdio: 'inherit', timeout: 10 * 60 * 1000, killSignal: 'SIGKILL' }
  )

  const { size } = fs.statSync(backupFile)
  if (size === 0) {
    throw new Error(`Backup file ${backupFile} is empty - aborting before touching the database.`)
  }
  console.log(`Backup OK (${size} bytes).`)
  return backupFile
}

async function run() {
  backupDatabase()

  const client = await pool.connect()
  try {
    const preTotal = (await client.query('SELECT COUNT(*) AS n FROM products')).rows[0].n
    console.log(`\nproducts before migration: ${preTotal}`)

    await client.query('BEGIN')

    console.log('\nAdding global review columns to products...')
    await client.query(`
      ALTER TABLE products
        ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected')),
        ADD COLUMN IF NOT EXISTS review_notes TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id),
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP
    `)
    await client.query('CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)')

    console.log('\nBackfilling status from existing product_stores history...')
    // A product is globally 'approved' if it was ever approved/synced for
    // at least one store, 'rejected' if it was explicitly rejected
    // everywhere and never approved, otherwise left at the column default
    // of 'pending' (covers products with no product_stores history at all).
    const approved = await client.query(`
      UPDATE products p
      SET status = 'approved'
      WHERE status = 'pending'
        AND EXISTS (
          SELECT 1 FROM product_stores ps
          WHERE ps.product_id = p.id AND ps.status IN ('approved', 'synced')
        )
    `)
    console.log(`  ${approved.rowCount} product(s) backfilled as 'approved'.`)

    const rejected = await client.query(`
      UPDATE products p
      SET status = 'rejected'
      WHERE status = 'pending'
        AND EXISTS (SELECT 1 FROM product_stores ps WHERE ps.product_id = p.id AND ps.status = 'rejected')
        AND NOT EXISTS (SELECT 1 FROM product_stores ps WHERE ps.product_id = p.id AND ps.status IN ('approved', 'synced'))
    `)
    console.log(`  ${rejected.rowCount} product(s) backfilled as 'rejected'.`)

    const statusBreakdown = (
      await client.query('SELECT status, COUNT(*) AS n FROM products GROUP BY status ORDER BY status')
    ).rows
    console.log('\nProducts status breakdown after backfill:', statusBreakdown)

    const postTotal = (await client.query('SELECT COUNT(*) AS n FROM products')).rows[0].n
    if (String(postTotal) !== String(preTotal)) {
      throw new Error(`Row count changed during migration (${preTotal} -> ${postTotal}). Aborting.`)
    }

    await client.query('COMMIT')
    console.log('\nMigration completed successfully.')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('\nMigration failed, rolled back:', err)
  process.exit(1)
})
