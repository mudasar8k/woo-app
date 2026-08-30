// Migration: adds the columns needed for the WordPress "WooApp Connector"
// plugin to pull products from WooApp over a simple API-key-authenticated
// REST endpoint (app/api/export/products/route.js), instead of WooApp
// having to reach into WooCommerce's REST API itself.
//
//   - stores.export_api_key: per-store secret the WordPress plugin sends
//     back to WooApp to identify itself and scope the export to one store.
//   - products.brand: previously dropped by the CSV parser (attribute:pa_Brand
//     wasn't mapped to anything); needed so brand data has somewhere to live
//     end-to-end from CSV import -> export endpoint -> WordPress import.
//
// Run with: node scripts/add-export-integration.js
const { Pool } = require('pg')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

function generateApiKey() {
  return crypto.randomBytes(24).toString('hex')
}

async function run() {
  const client = await pool.connect()
  try {
    console.log('Adding brand column to products...')
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(255)')

    console.log('Adding export_api_key column to stores...')
    await client.query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS export_api_key VARCHAR(64)')

    console.log('Backfilling export_api_key for stores that do not have one yet...')
    const { rows: storesNeedingKeys } = await client.query(
      'SELECT id FROM stores WHERE export_api_key IS NULL'
    )

    for (const store of storesNeedingKeys) {
      await client.query('UPDATE stores SET export_api_key = $1 WHERE id = $2', [
        generateApiKey(),
        store.id,
      ])
    }
    console.log(`  Generated keys for ${storesNeedingKeys.length} store(s).`)

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
