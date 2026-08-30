/**
 * Async Ralawise sync job helpers (ralawise_sync_jobs table).
 */

const JOB_STATUS = {
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  DOWNLOADING: 'downloading',
  DELTA: 'delta',
  IMPORTING_PRODUCTS: 'importing_products',
  IMPORTING_VARIATIONS: 'importing_variations',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
}

const ALLOWED_STATUSES = [
  'queued',
  'connecting',
  'downloading',
  'delta',
  'importing_products',
  'importing_variations',
  'paused',
  'completed',
  'failed',
]

class SyncPausedError extends Error {
  constructor(message = 'Sync paused') {
    super(message)
    this.name = 'SyncPausedError'
    this.code = 'SYNC_PAUSED'
  }
}

function isSyncPausedError(error) {
  return (
    error?.code === 'SYNC_PAUSED' ||
    error?.name === 'SyncPausedError' ||
    /sync paused/i.test(error?.message || '')
  )
}

const CREATE_TABLE_SQL = `
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
`

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ralawise_sync_jobs_store
  ON ralawise_sync_jobs(store_id, created_at DESC)
`

const ALTER_COLUMNS = [
  ['initiated_by', 'INTEGER'],
  ['status', "VARCHAR(40) DEFAULT 'queued'"],
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

let tableReady = false

async function ensureJobsTable(db) {
  if (tableReady) return
  await db.query(CREATE_TABLE_SQL)
  for (const [name, definition] of ALTER_COLUMNS) {
    await db.query(
      `ALTER TABLE ralawise_sync_jobs ADD COLUMN IF NOT EXISTS ${name} ${definition}`
    )
  }
  await db.query(`
    ALTER TABLE ralawise_sync_jobs
    DROP CONSTRAINT IF EXISTS ralawise_sync_jobs_status_check
  `)
  await db.query(`
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
  await db.query(CREATE_INDEX_SQL)
  tableReady = true
}

async function createSyncJob(db, { storeId, vendorId, userId }) {
  await ensureJobsTable(db)
  const result = await db.query(
    `INSERT INTO ralawise_sync_jobs
       (store_id, vendor_id, initiated_by, status, step, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      storeId,
      vendorId,
      userId || null,
      JOB_STATUS.QUEUED,
      JOB_STATUS.QUEUED,
      'Queued',
    ]
  )
  return result.rows[0]
}

/**
 * Partial update of a sync job row.
 * Only provided fields are written.
 */
async function updateSyncJob(db, jobId, fields = {}) {
  await ensureJobsTable(db)

  const allowed = [
    'status',
    'step',
    'message',
    'current_count',
    'total_count',
    'products_new',
    'products_updated',
    'products_skipped',
    'products_errors',
    'variations_new',
    'variations_updated',
    'variations_skipped',
    'variations_errors',
    'result_json',
    'error_message',
    'started_at',
    'completed_at',
  ]

  const sets = []
  const values = []
  let i = 1

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = $${i}`)
      values.push(fields[key])
      i++
    }
  }

  if (sets.length === 0) {
    return getSyncJob(db, jobId)
  }

  sets.push('updated_at = CURRENT_TIMESTAMP')
  values.push(jobId)

  const result = await db.query(
    `UPDATE ralawise_sync_jobs SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  )
  return result.rows[0] || null
}

async function getSyncJob(db, jobId) {
  await ensureJobsTable(db)
  const result = await db.query(
    `SELECT * FROM ralawise_sync_jobs WHERE id = $1`,
    [jobId]
  )
  return result.rows[0] || null
}

function serializeJob(row) {
  if (!row) return null

  const current = row.current_count || 0
  const total = row.total_count || 0
  const progressPercent =
    total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0

  return {
    jobId: row.id,
    storeId: row.store_id,
    vendorId: row.vendor_id,
    status: row.status,
    step: row.step,
    message: row.message,
    current: current,
    total: total,
    progressPercent,
    products: {
      new: row.products_new || 0,
      updated: row.products_updated || 0,
      skipped: row.products_skipped || 0,
      errors: row.products_errors || 0,
    },
    variations: {
      new: row.variations_new || 0,
      updated: row.variations_updated || 0,
      skipped: row.variations_skipped || 0,
      errors: row.variations_errors || 0,
    },
    result: row.result_json || null,
    error: row.error_message || null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Throw if the job was paused by the user (stop button).
 */
async function assertJobNotPaused(db, jobId) {
  const job = await getSyncJob(db, jobId)
  if (job?.status === JOB_STATUS.PAUSED) {
    throw new SyncPausedError(
      job.message || 'Sync paused — click Resume to continue'
    )
  }
  return job
}

/**
 * Build an onProgress callback that writes job progress to the DB.
 * Throws SyncPausedError if the job was stopped.
 */
function makeJobProgressUpdater(db, jobId) {
  return async function onProgress(progress = {}) {
    await assertJobNotPaused(db, jobId)

    const fields = {}

    if (progress.step != null) {
      fields.status = progress.step
      fields.step = progress.step
    }
    if (progress.status != null) {
      fields.status = progress.status
    }
    if (progress.message != null) fields.message = progress.message
    if (progress.current != null) fields.current_count = progress.current
    if (progress.total != null) fields.total_count = progress.total

    if (progress.products_new != null) fields.products_new = progress.products_new
    if (progress.products_updated != null) {
      fields.products_updated = progress.products_updated
    }
    if (progress.products_skipped != null) {
      fields.products_skipped = progress.products_skipped
    }
    if (progress.products_errors != null) {
      fields.products_errors = progress.products_errors
    }
    if (progress.variations_new != null) {
      fields.variations_new = progress.variations_new
    }
    if (progress.variations_updated != null) {
      fields.variations_updated = progress.variations_updated
    }
    if (progress.variations_skipped != null) {
      fields.variations_skipped = progress.variations_skipped
    }
    if (progress.variations_errors != null) {
      fields.variations_errors = progress.variations_errors
    }

    if (progress.newCount != null && progress.step === JOB_STATUS.IMPORTING_PRODUCTS) {
      fields.products_new = progress.newCount
    }
    if (
      progress.updatedCount != null &&
      progress.step === JOB_STATUS.IMPORTING_PRODUCTS
    ) {
      fields.products_updated = progress.updatedCount
    }
    if (
      progress.newCount != null &&
      progress.step === JOB_STATUS.IMPORTING_VARIATIONS
    ) {
      fields.variations_new = progress.newCount
    }
    if (
      progress.updatedCount != null &&
      progress.step === JOB_STATUS.IMPORTING_VARIATIONS
    ) {
      fields.variations_updated = progress.updatedCount
    }

    if (Object.keys(fields).length === 0) return
    await updateSyncJob(db, jobId, fields)
    await assertJobNotPaused(db, jobId)
  }
}

module.exports = {
  JOB_STATUS,
  ALLOWED_STATUSES,
  SyncPausedError,
  isSyncPausedError,
  ensureJobsTable,
  createSyncJob,
  updateSyncJob,
  getSyncJob,
  serializeJob,
  assertJobNotPaused,
  makeJobProgressUpdater,
}
