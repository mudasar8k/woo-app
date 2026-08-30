// Migration: adds vendor_id directly on products so each product row owns
// its vendor (scalable queries/filtering) instead of requiring a JOIN
// through csv_uploads.
//
// Run with: npm run migrate:product-vendor
const { Pool } = require('pg')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

async function run() {
  const client = await pool.connect()
  try {
    console.log('Adding vendor_id column to products...')
    await client.query(
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id)'
    )

    console.log('Backfilling vendor_id from csv_uploads...')
    const backfillResult = await client.query(`
      UPDATE products p
      SET vendor_id = cu.vendor_id
      FROM csv_uploads cu
      WHERE p.csv_upload_id = cu.id AND p.vendor_id IS NULL
    `)
    console.log(`  Updated ${backfillResult.rowCount} product row(s).`)

    console.log('Creating index on products.vendor_id...')
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_products_vendor_id ON products(vendor_id)'
    )

    const { rows: nullRows } = await client.query(
      'SELECT COUNT(*)::int AS count FROM products WHERE vendor_id IS NULL'
    )
    const nullCount = nullRows[0].count

    if (nullCount === 0) {
      console.log('Setting vendor_id NOT NULL constraint...')
      await client.query('ALTER TABLE products ALTER COLUMN vendor_id SET NOT NULL')
    } else {
      console.warn(
        `  Skipping NOT NULL constraint: ${nullCount} product(s) still have no vendor_id.`
      )
    }

    console.log('Migration completed successfully.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
