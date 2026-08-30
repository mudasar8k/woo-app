// Migration: adds product specification columns (fabric, weight, size_description, length_fit)
// to products table so Ralawise specifications persist and export cleanly.
//
// Run with: node scripts/add-product-specifications.js
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
    console.log('Adding specification columns to products table...')
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS fabric TEXT')
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS weight VARCHAR(100)')
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS size_description TEXT')
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS length_fit VARCHAR(255)')

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
