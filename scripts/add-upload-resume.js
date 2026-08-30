// Migration: track chunk progress so CSV uploads can resume after interruption.
// Run with: npm run migrate:upload-resume
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
    console.log('Adding upload resume columns to csv_uploads...')
    await client.query(`
      ALTER TABLE csv_uploads
        ADD COLUMN IF NOT EXISTS expected_row_count INTEGER,
        ADD COLUMN IF NOT EXISTS processed_row_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_chunk_index INTEGER DEFAULT -1,
        ADD COLUMN IF NOT EXISTS total_chunks INTEGER
    `)

    console.log('Backfilling expected_row_count from row_count...')
    await client.query(`
      UPDATE csv_uploads
      SET expected_row_count = row_count
      WHERE expected_row_count IS NULL AND row_count IS NOT NULL
    `)

    console.log('Upload resume migration complete.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
