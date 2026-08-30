const { Pool } = require('pg')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
})

async function assignVendorsToStores() {
  try {
    const stores = await pool.query('SELECT id, name FROM stores ORDER BY id')

    for (const store of stores.rows) {
      const result = await pool.query(
        `INSERT INTO vendor_stores (vendor_id, store_id)
         SELECT id, $1 FROM vendors WHERE status = 'active'
         ON CONFLICT (vendor_id, store_id) DO NOTHING
         RETURNING id`,
        [store.id]
      )

      console.log(
        `Store "${store.name}" (id=${store.id}): assigned ${result.rowCount} vendor(s)`
      )
    }

    console.log('Done.')
  } catch (error) {
    console.error('Error assigning vendors to stores:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

assignVendorsToStores()
