// Migration: adds stores.price_rule_percent — a per-store markup % applied
// on top of Ralawise/CSV cost when exporting to WordPress and when showing
// "Store price" in the product table.
//
// Null means no rule (export/UI fall back to regular_price / price as today).
//
// Run with: node scripts/add-price-rule.js
//   or:     npm run migrate:price-rule
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
    console.log('Adding price_rule_percent column to stores...')
    await client.query(
      'ALTER TABLE stores ADD COLUMN IF NOT EXISTS price_rule_percent DECIMAL(6, 2) DEFAULT NULL'
    )
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
