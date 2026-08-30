// Migration: ralawise_sync_jobs for async sync + progress polling.
// Run with: npm run migrate:ralawise-jobs
const { Pool } = require('pg')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
})

const ALTER_COLUMNS = [
  ['initiated_by', 'INTEGER REFERENCES users(id)'],
  ['status', "VARCHAR(40) NOT NULL DEFAULT 'queued'"],
  ['step', 'VARCHAR(80)'],
  ['message', 'TEXT'],
  ['current_count', 'INTEGER DEFAULT 0'],
  ['total_count', 'INTEGER DEFAULT 0'],
  ['products_new', 'INTEGER DEFAULT 0'],
  ['products_updated', 'INTEGER DEFAULT 0'],
  ['products_skipped', 'INTEGER DEFAULT 0'],
  ['products_errors', 'INTEGER DEFAULT 0'],
  ['variations_new', 'INTEGER DEFAULT 0'],
  ['variations_updated', 'INTEGER DEFAULT 0'],
  ['variations_skipped', 'INTEGER DEFAULT 0'],
  ['variations_errors', 'INTEGER DEFAULT 0'],
  ['result_json', 'JSONB'],
  ['error_message', 'TEXT'],
  ['started_at', 'TIMESTAMP'],
  ['completed_at', 'TIMESTAMP'],
  ['created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
  ['updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
]

async function run() {
  const client = await pool.connect()
  try {
    console.log('Creating ralawise_sync_jobs…')
    await client.query(`
      CREATE TABLE IF NOT EXISTS ralawise_sync_jobs (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        vendor_id INTEGER NOT NULL REFERENCES vendors(id),
        initiated_by INTEGER REFERENCES users(id),
        status VARCHAR(40) NOT NULL DEFAULT 'queued',
        step VARCHAR(80),
        message TEXT,
        current_count INTEGER DEFAULT 0,
        total_count INTEGER DEFAULT 0,
        products_new INTEGER DEFAULT 0,
        products_updated INTEGER DEFAULT 0,
        products_skipped INTEGER DEFAULT 0,
        products_errors INTEGER DEFAULT 0,
        variations_new INTEGER DEFAULT 0,
        variations_updated INTEGER DEFAULT 0,
        variations_skipped INTEGER DEFAULT 0,
        variations_errors INTEGER DEFAULT 0,
        result_json JSONB,
        error_message TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [name, definition] of ALTER_COLUMNS) {
      await client.query(
        `ALTER TABLE ralawise_sync_jobs ADD COLUMN IF NOT EXISTS ${name} ${definition}`
      )
    }

    await client.query(`
      ALTER TABLE ralawise_sync_jobs
      DROP CONSTRAINT IF EXISTS ralawise_sync_jobs_status_check
    `)
    await client.query(`
      ALTER TABLE ralawise_sync_jobs
      ADD CONSTRAINT ralawise_sync_jobs_status_check
      CHECK (status IN (
        'queued',
        'connecting',
        'downloading',
        'delta',
        'importing_products',
        'importing_variations',
        'paused',
        'completed',
        'failed'
      ))
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ralawise_sync_jobs_store
      ON ralawise_sync_jobs(store_id, created_at DESC)
    `)
    console.log('ralawise_sync_jobs migration complete.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
