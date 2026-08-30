// Migration: lets a store be created with either connection method:
//   - 'api'    same as before - WooApp pushes to WooCommerce using
//              consumer_key/consumer_secret (REST API).
//   - 'plugin' WooApp does nothing outbound; the WordPress "WooApp
//              Connector" plugin pulls from /api/export/* instead, using
//              the store's export_api_key. No WooCommerce REST keys needed.
//
// consumer_key/consumer_secret are no longer required at the DB level
// since 'plugin' stores may never set them.
//
// Run with: node scripts/add-connection-method.js
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
    console.log('Adding connection_method column to stores...')
    await client.query(
      "ALTER TABLE stores ADD COLUMN IF NOT EXISTS connection_method VARCHAR(20) DEFAULT 'api'"
    )

    console.log('Backfilling connection_method for existing stores...')
    await client.query(
      "UPDATE stores SET connection_method = 'api' WHERE connection_method IS NULL"
    )

    console.log('Relaxing consumer_key/consumer_secret to nullable (plugin-connected stores may not have them)...')
    await client.query('ALTER TABLE stores ALTER COLUMN consumer_key DROP NOT NULL')
    await client.query('ALTER TABLE stores ALTER COLUMN consumer_secret DROP NOT NULL')

    console.log('Adding a check constraint on connection_method...')
    try {
      await client.query(
        "ALTER TABLE stores ADD CONSTRAINT stores_connection_method_check CHECK (connection_method IN ('api', 'plugin'))"
      )
    } catch (e) {
      if (e.code !== '42710' && e.code !== '42P07') throw e // already exists
      console.log('  (constraint already exists)')
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
