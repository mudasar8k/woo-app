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
  FINALIZE: 'finalize',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
}

const ALLOWED_STATUSES = [
  'queued',
  'connecting',
  'downloading',
  'delta',
  'importing_products',
  'importing_variations',
  'finalize',
  'paused',
  'completed',
  'failed',
  'abandoned',
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
    phase VARCHAR(40) DEFAULT 'prepare',
    message TEXT,
    current_count BIGINT DEFAULT 0,
    total_count BIGINT DEFAULT 0,
    parent_total BIGINT DEFAULT 0,
    parent_processed BIGINT DEFAULT 0,
    parent_cursor BIGINT DEFAULT 0,
    variation_total BIGINT DEFAULT 0,
    variation_processed BIGINT DEFAULT 0,
    variation_cursor BIGINT DEFAULT 0,
    products_new BIGINT DEFAULT 0,
    products_updated BIGINT DEFAULT 0,
    products_skipped BIGINT DEFAULT 0,
    products_errors BIGINT DEFAULT 0,
    variations_new BIGINT DEFAULT 0,
    variations_updated BIGINT DEFAULT 0,
    variations_skipped BIGINT DEFAULT 0,
    variations_errors BIGINT DEFAULT 0,
    cancel_requested BOOLEAN DEFAULT FALSE,
    csv_upload_parent_id INTEGER,
    csv_upload_var_id INTEGER,
    result_json JSONB,
    error_message TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`

const CREATE_PAYLOADS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ralawise_sync_job_payloads (
    job_id INTEGER PRIMARY KEY REFERENCES ralawise_sync_jobs(id) ON DELETE CASCADE,
    parent_rows JSONB,
    variation_rows JSONB,
    raw_parent_text TEXT,
    raw_var_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  ['phase', "VARCHAR(40) DEFAULT 'prepare'"],
  ['message', 'TEXT'],
  ['current_count', 'BIGINT DEFAULT 0'],
  ['total_count', 'BIGINT DEFAULT 0'],
  ['parent_total', 'BIGINT DEFAULT 0'],
  ['parent_processed', 'BIGINT DEFAULT 0'],
  ['parent_cursor', 'BIGINT DEFAULT 0'],
  ['variation_total', 'BIGINT DEFAULT 0'],
  ['variation_processed', 'BIGINT DEFAULT 0'],
  ['variation_cursor', 'BIGINT DEFAULT 0'],
  ['products_new', 'BIGINT DEFAULT 0'],
  ['products_updated', 'BIGINT DEFAULT 0'],
  ['products_skipped', 'BIGINT DEFAULT 0'],
  ['products_errors', 'BIGINT DEFAULT 0'],
  ['variations_new', 'BIGINT DEFAULT 0'],
  ['variations_updated', 'BIGINT DEFAULT 0'],
  ['variations_skipped', 'BIGINT DEFAULT 0'],
  ['variations_errors', 'BIGINT DEFAULT 0'],
  ['cancel_requested', 'BOOLEAN DEFAULT FALSE'],
  ['csv_upload_parent_id', 'INTEGER'],
  ['csv_upload_var_id', 'INTEGER'],
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
  await db.query(CREATE_PAYLOADS_TABLE_SQL)
  for (const [name, definition] of ALTER_COLUMNS) {
    await db.query(
      `ALTER TABLE ralawise_sync_jobs ADD COLUMN IF NOT EXISTS ${name} ${definition}`
    )
  }
  await db.query(`
    ALTER TABLE ralawise_sync_jobs ALTER COLUMN initiated_by DROP NOT NULL
  `).catch(() => {})
  await db.query(`
    ALTER TABLE product_variations ALTER COLUMN csv_upload_id DROP NOT NULL
  `).catch(() => {})
  await db.query(`
    ALTER TABLE products ALTER COLUMN csv_upload_id DROP NOT NULL
  `).catch(() => {})
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
      'finalize',
      'paused',
      'completed',
      'failed',
      'abandoned'
    ))
  `)
  await db.query(CREATE_INDEX_SQL)
  tableReady = true
}

async function createSyncJob(db, { storeId, vendorId, userId }) {
  await ensureJobsTable(db)
  const result = await db.query(
    `INSERT INTO ralawise_sync_jobs
       (store_id, vendor_id, initiated_by, status, step, phase, message, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      storeId,
      vendorId,
      userId || null,
      JOB_STATUS.QUEUED,
      JOB_STATUS.QUEUED,
      'prepare',
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
    'phase',
    'message',
    'current_count',
    'total_count',
    'parent_total',
    'parent_processed',
    'parent_cursor',
    'variation_total',
    'variation_processed',
    'variation_cursor',
    'products_new',
    'products_updated',
    'products_skipped',
    'products_errors',
    'variations_new',
    'variations_updated',
    'variations_skipped',
    'variations_errors',
    'cancel_requested',
    'csv_upload_parent_id',
    'csv_upload_var_id',
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

async function getActiveSyncJobForStore(db, storeId) {
  await ensureJobsTable(db)
  // Fetch the single most-recent job for this store, then decide whether it is
  // "active". We must NOT look past a terminal job to find older stale rows —
  // that would cause a crashed job from a previous session to be rediscovered
  // and re-run automatically after a later sync has already completed.
  const result = await db.query(
    `SELECT * FROM ralawise_sync_jobs
     WHERE store_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [storeId]
  )
  const row = result.rows[0]
  if (!row) return null
  if (
    row.status === JOB_STATUS.COMPLETED ||
    row.status === JOB_STATUS.FAILED ||
    row.status === JOB_STATUS.ABANDONED
  ) return null
  return row
}

async function saveJobPayloads(db, jobId, { parentRows, variationRows, rawParentText, rawVarText }) {
  await ensureJobsTable(db)
  await db.query(
    `INSERT INTO ralawise_sync_job_payloads (job_id, parent_rows, variation_rows, raw_parent_text, raw_var_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO UPDATE SET
       parent_rows = EXCLUDED.parent_rows,
       variation_rows = EXCLUDED.variation_rows,
       raw_parent_text = EXCLUDED.raw_parent_text,
       raw_var_text = EXCLUDED.raw_var_text`,
    [
      jobId,
      JSON.stringify(parentRows || []),
      JSON.stringify(variationRows || []),
      rawParentText || null,
      rawVarText || null,
    ]
  )
}

async function getJobPayloads(db, jobId) {
  await ensureJobsTable(db)
  const result = await db.query(
    `SELECT (parent_rows IS NOT NULL) as has_parents, (variation_rows IS NOT NULL) as has_vars,
            raw_parent_text, raw_var_text
     FROM ralawise_sync_job_payloads WHERE job_id = $1`,
    [jobId]
  )
  if (result.rows.length === 0) return null
  return {
    hasParents: result.rows[0].has_parents,
    hasVars: result.rows[0].has_vars,
    rawParentText: result.rows[0].raw_parent_text,
    rawVarText: result.rows[0].raw_var_text,
  }
}

async function getParentBatchSlice(db, jobId, start, limit) {
  await ensureJobsTable(db)
  const end = Math.max(0, start + limit - 1)
  const result = await db.query(
    `SELECT jsonb_path_query_array(parent_rows, ('$[' || $2::text || ' to ' || $3::text || ']')::jsonpath) as slice
     FROM ralawise_sync_job_payloads WHERE job_id = $1`,
    [jobId, start, end]
  )
  if (result.rows.length === 0) return null
  const slice = result.rows[0].slice
  const rows = Array.isArray(slice) ? slice : (typeof slice === 'string' ? JSON.parse(slice) : [])
  return { rows }
}

async function getVariationBatchSlice(db, jobId, start, limit) {
  await ensureJobsTable(db)
  const end = Math.max(0, start + limit - 1)
  const result = await db.query(
    `SELECT jsonb_path_query_array(variation_rows, ('$[' || $2::text || ' to ' || $3::text || ']')::jsonpath) as slice
     FROM ralawise_sync_job_payloads WHERE job_id = $1`,
    [jobId, start, end]
  )
  if (result.rows.length === 0) return null
  const slice = result.rows[0].slice
  const rows = Array.isArray(slice) ? slice : (typeof slice === 'string' ? JSON.parse(slice) : [])
  return { rows }
}

async function cleanupJobPayloads(db, jobId) {
  await ensureJobsTable(db)
  await db.query(`DELETE FROM ralawise_sync_job_payloads WHERE job_id = $1`, [jobId])
}

function serializeJob(row) {
  if (!row) return null

  const parentTotal = Number(row.parent_total) || 0
  const parentProcessed = Number(row.parent_processed) || 0
  const varTotal = Number(row.variation_total) || 0
  const varProcessed = Number(row.variation_processed) || 0

  const grandTotal = parentTotal + varTotal || Number(row.total_count) || 0
  const grandProcessed = parentProcessed + varProcessed || Number(row.current_count) || 0
  const progressPercent =
    grandTotal > 0 ? Math.min(100, Math.round((grandProcessed / grandTotal) * 100)) : 0

  return {
    jobId: row.id,
    storeId: row.store_id,
    vendorId: row.vendor_id,
    status: row.status,
    step: row.step,
    phase: row.phase || 'prepare',
    message: row.message,
    current: grandProcessed,
    total: grandTotal,
    parentTotal,
    parentProcessed,
    parentCursor: Number(row.parent_cursor) || 0,
    variationTotal: varTotal,
    variationProcessed: varProcessed,
    variationCursor: Number(row.variation_cursor) || 0,
    cancelRequested: Boolean(row.cancel_requested),
    progressPercent,
    products: {
      new: Number(row.products_new) || 0,
      updated: Number(row.products_updated) || 0,
      skipped: Number(row.products_skipped) || 0,
      errors: Number(row.products_errors) || 0,
    },
    variations: {
      new: Number(row.variations_new) || 0,
      updated: Number(row.variations_updated) || 0,
      skipped: Number(row.variations_skipped) || 0,
      errors: Number(row.variations_errors) || 0,
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
  if (
    job?.status === JOB_STATUS.PAUSED ||
    job?.status === JOB_STATUS.ABANDONED ||
    job?.cancel_requested
  ) {
    throw new SyncPausedError(
      job.message || 'Sync paused - click Resume to continue'
    )
  }
  return job
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
  getActiveSyncJobForStore,
  saveJobPayloads,
  getJobPayloads,
  getParentBatchSlice,
  getVariationBatchSlice,
  cleanupJobPayloads,
  serializeJob,
  assertJobNotPaused,
}
