const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const { Pool } = require('pg')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('ERROR: DATABASE_URL is not set.')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

async function runMigration() {
  const client = await pool.connect()
  try {
    console.log('Beginning variation_store_pricing table migration...')

    await client.query('BEGIN')

    // 1. Create variation_store_pricing table
    await client.query(`
      CREATE TABLE IF NOT EXISTS variation_store_pricing (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        variation_id INTEGER NOT NULL REFERENCES product_variations(id) ON DELETE CASCADE,
        override_type VARCHAR(50) NOT NULL DEFAULT 'product_rules',
        custom_markup_percent DECIMAL(6, 2) DEFAULT NULL,
        fixed_price DECIMAL(10, 2) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT variation_store_pricing_store_variation_unique UNIQUE (store_id, variation_id),
        CONSTRAINT variation_store_pricing_override_type_check CHECK (override_type IN ('product_rules', 'custom_markup', 'fixed_price')),
        CONSTRAINT variation_store_pricing_markup_check CHECK (custom_markup_percent IS NULL OR custom_markup_percent >= 0),
        CONSTRAINT variation_store_pricing_fixed_check CHECK (fixed_price IS NULL OR fixed_price >= 0)
      );
    `)

    // 2. Add indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variation_store_pricing_store_product ON variation_store_pricing(store_id, product_id);
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variation_store_pricing_store_variation ON variation_store_pricing(store_id, variation_id);
    `)

    await client.query('COMMIT')
    console.log('variation_store_pricing table and indexes created successfully.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

runMigration()
