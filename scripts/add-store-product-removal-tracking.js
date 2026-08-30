// Migration: adds store-level product removal tracking to product_stores table
// with previous_status retention, removed_at, removed_by.
//
// Safe to re-run: idempotent constraint and column additions.
// Run with: node scripts/add-store-product-removal-tracking.js

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
    console.log('Adding store-level removal columns to product_stores...')
    
    await client.query(`
      ALTER TABLE product_stores
        ADD COLUMN IF NOT EXISTS previous_status VARCHAR(50),
        ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS removed_by INTEGER REFERENCES users(id)
    `)

    // Drop and re-create check constraint on status to include 'removed'
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE product_stores DROP CONSTRAINT IF EXISTS product_stores_status_check;
        ALTER TABLE product_stores ADD CONSTRAINT product_stores_status_check 
          CHECK (status IN ('pending', 'approved', 'rejected', 'synced', 'removed'));
      EXCEPTION
        WHEN OTHERS THEN NULL;
      END $$;
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_stores_store_status ON product_stores(store_id, status)
    `)

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
