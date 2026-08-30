// Migration: app_settings key/value store + default_price_rule_percent.
// Super admin sets the global default; each store can override via
// stores.price_rule_percent (NULL = use default).
//
// Run with: node scripts/add-app-settings.js
//   or:     npm run migrate:app-settings
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
    console.log('Creating app_settings table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    console.log('Ensuring stores.price_rule_percent exists (store override)...')
    await client.query(
      'ALTER TABLE stores ADD COLUMN IF NOT EXISTS price_rule_percent DECIMAL(6, 2) DEFAULT NULL'
    )

    console.log('Seeding default_price_rule_percent if missing...')
    await client.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('default_price_rule_percent', NULL)
       ON CONFLICT (key) DO NOTHING`
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
