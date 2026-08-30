// Rollback Migration: safely reverts range-based pricing rules schema.
// - Drops product_store_pricing table
// - Drops store_pricing_rules table
// - Removes stores.pricing_mode and stores.fallback_markup_percent columns
//
// Existing stores.price_rule_percent and all product supplier costs remain untouched.
// Run with: node scripts/rollback-range-pricing-rules.js
//   or:     npm run rollback:range-pricing

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
    console.log('Beginning range pricing rules schema rollback...')

    // 1. Drop product_store_pricing table
        await client.query('DROP TABLE IF EXISTS store_category_pricing_rules CASCADE;')
    await client.query('DROP TABLE IF EXISTS product_store_pricing CASCADE;')

    // 2. Drop store_pricing_rules table
    await client.query('DROP TABLE IF EXISTS store_pricing_rules CASCADE;')

    // 3. Drop constraint and columns from stores table
    await client.query(`
      ALTER TABLE stores
        DROP CONSTRAINT IF EXISTS stores_pricing_mode_check,
        DROP COLUMN IF EXISTS pricing_mode,
        DROP COLUMN IF EXISTS fallback_markup_percent;
    `)

    console.log('Range pricing rollback completed successfully.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('Rollback failed:', err)
  process.exit(1)
})
