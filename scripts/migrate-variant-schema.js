const { Pool } = require('pg')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

async function run() {
  const client = await pool.connect()
  try {
    console.log('Adding tax_class and images to product_variations...')
    await client.query('ALTER TABLE product_variations ADD COLUMN IF NOT EXISTS tax_class VARCHAR(100)')
    await client.query('ALTER TABLE product_variations ADD COLUMN IF NOT EXISTS images TEXT')
    
    console.log('Adding size and color columns to product_variations...')
    await client.query('ALTER TABLE product_variations ADD COLUMN IF NOT EXISTS size VARCHAR(255)')
    await client.query('ALTER TABLE product_variations ADD COLUMN IF NOT EXISTS color VARCHAR(255)')

    console.log('De-duplicating products by (store_id, sku)...')
    await client.query(`
      DELETE FROM products a USING products b
      WHERE a.id > b.id AND a.store_id = b.store_id AND a.sku IS NOT NULL AND a.sku = b.sku
    `)

    console.log('De-duplicating product_variations by (product_id, sku)...')
    await client.query(`
      DELETE FROM product_variations a USING product_variations b
      WHERE a.id > b.id AND a.product_id = b.product_id AND a.sku IS NOT NULL AND a.sku = b.sku
    `)

    console.log('Adding UNIQUE(store_id, sku) on products...')
    try {
      await client.query('ALTER TABLE products ADD CONSTRAINT products_store_sku_unique UNIQUE (store_id, sku)')
    } catch (e) {
      if (e.code !== '42P07') throw e
      console.log('  (constraint already exists)')
    }

    console.log('Adding UNIQUE(product_id, sku) on product_variations...')
    try {
      await client.query('ALTER TABLE product_variations ADD CONSTRAINT product_variations_product_sku_unique UNIQUE (product_id, sku)')
    } catch (e) {
      if (e.code !== '42P07') throw e
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
