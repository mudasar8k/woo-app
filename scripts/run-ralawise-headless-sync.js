/**
 * Headless HTTP Orchestrator for Ralawise Scheduled Sync.
 * Runs inside GitHub Actions as the long-running coordinator, driving short bounded requests to WooApp on Vercel.
 *
 * Usage: node scripts/run-ralawise-headless-sync.js [--force]
 */

const WOOAPP_URL = (process.env.WOOAPP_URL || 'https://wooapp.southline.co.uk').replace(/\/+$/, '')
const CRON_SECRET = process.env.RALAWISE_SYNC_CRON_SECRET || ''

const isForce = process.argv.includes('--force')

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt++
    try {
      const res = await fetch(url, options)
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        return { ok: true, data, status: res.status }
      }
      // If client error (4xx) other than 429, don't retry endlessly
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { ok: false, data, status: res.status, error: data?.error || `HTTP ${res.status}` }
      }
      console.warn(`[Orchestrator] Attempt ${attempt} returned status ${res.status}: ${data?.error || 'Server error'}`)
    } catch (err) {
      console.warn(`[Orchestrator] Attempt ${attempt} network error: ${err.message}`)
    }
    if (attempt < maxAttempts) {
      const delayMs = attempt * 2000
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return { ok: false, error: `Exhausted ${maxAttempts} attempts for ${url}` }
}

async function main() {
  console.log('====================================================')
  console.log('RALAWISE SCHEDULED SYNC: GITHUB ACTIONS ORCHESTRATOR')
  console.log(`Target: ${WOOAPP_URL}`)
  console.log(`Force Mode: ${isForce}`)
  console.log('====================================================')

  if (!CRON_SECRET) {
    console.error('ERROR: RALAWISE_SYNC_CRON_SECRET is not configured.')
    process.exit(1)
  }

  const authHeader = {
    Authorization: `Bearer ${CRON_SECRET}`,
    'Content-Type': 'application/json',
  }

  // Step 1: Trigger Schedule Check & Prepare
  console.log('\n[Step 1] Triggering scheduler check & prepare on WooApp...')
  const checkRes = await fetchWithRetry(`${WOOAPP_URL}/api/ralawise/scheduled-sync/check`, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ force: isForce }),
  })

  if (!checkRes.ok) {
    console.error(`Scheduler check failed: ${checkRes.error}`)
    process.exit(1)
  }

  const checkData = checkRes.data
  console.log(`Scheduler response: Global Flag=${checkData.global_enabled}, UK Time=${checkData.uk_time}`)

  if (checkData.skipped && checkData.skipped.length > 0) {
    for (const s of checkData.skipped) {
      console.log(`  [SKIP] Store ${s.store_id} (${s.store_name || ''}): ${s.reason}`)
    }
  }

  if (!checkData.executed || checkData.executed.length === 0) {
    console.log('\nNo stores are due for scheduled sync. Exiting cleanly.')
    process.exit(0)
  }

  // Step 2: Orchestrate Bounded Batches for Each Prepared Job
  for (const exec of checkData.executed) {
    const jobId = exec.job_id
    const storeName = exec.store_name || `Store #${exec.store_id}`
    console.log(`\n====================================================`)
    console.log(`[Step 2] Processing Job #${jobId} for ${storeName}`)
    console.log(`====================================================`)

    if (exec.no_changes) {
      console.log('No supplier catalog changes detected since last sync. Finalized automatically.')
      continue
    }

    // A. Parent Products Loop
    let parentPhaseActive = true
    while (parentPhaseActive) {
      const batchRes = await fetchWithRetry(`${WOOAPP_URL}/api/ralawise/sync/${jobId}/batch-parents`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ batchSize: 50 }),
      })

      if (!batchRes.ok) {
        console.error(`\n[ERROR] Parent batch failed for Job #${jobId}: ${batchRes.error}`)
        process.exit(1)
      }

      const resData = batchRes.data
      const job = resData.job || {}

      if (resData.paused || job.status === 'paused') {
        console.warn(`\n[PAUSED] Job #${jobId} was paused.`)
        process.exit(0)
      }

      const processed = Number(job.parentProcessed || 0)
      const total = Number(job.parentTotal || exec.parent_total || 0)
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0

      // Log progress periodically or on phase end
      if (processed % 250 === 0 || !resData.hasMore || resData.phase !== 'parents') {
        console.log(`  [Parents] Progress: ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`)
      }

      if (!resData.hasMore || resData.phase !== 'parents') {
        parentPhaseActive = false
        console.log(`  ? Parent product phase completed (${processed.toLocaleString()} products).`)
      }
    }

    // B. Variations Loop
    let varPhaseActive = true
    while (varPhaseActive) {
      const batchRes = await fetchWithRetry(`${WOOAPP_URL}/api/ralawise/sync/${jobId}/batch-variations`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ batchSize: 25 }),
      })

      if (!batchRes.ok) {
        console.error(`\n[ERROR] Variation batch failed for Job #${jobId}: ${batchRes.error}`)
        process.exit(1)
      }

      const resData = batchRes.data
      const job = resData.job || {}

      if (resData.paused || job.status === 'paused') {
        console.warn(`\n[PAUSED] Job #${jobId} was paused.`)
        process.exit(0)
      }

      const processed = Number(job.variationProcessed || 0)
      const total = Number(job.variationTotal || exec.variation_total || 0)
      const pct = total > 0 ? Math.round((processed / total) * 100) : 0

      // Log progress periodically or on phase end
      if (processed % 1000 === 0 || !resData.hasMore || resData.phase !== 'variations') {
        console.log(`  [Variations] Progress: ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`)
      }

      if (!resData.hasMore || resData.phase !== 'variations') {
        varPhaseActive = false
        console.log(`  ? Variation phase completed (${processed.toLocaleString()} variations).`)
      }
    }

    // C. Finalize
    console.log(`\n[Step 3] Finalizing Job #${jobId}...`)
    const finRes = await fetchWithRetry(`${WOOAPP_URL}/api/ralawise/sync/${jobId}/finalize`, {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({}),
    })

    if (!finRes.ok) {
      console.error(`\n[ERROR] Finalize failed for Job #${jobId}: ${finRes.error}`)
      process.exit(1)
    }

    console.log(`  ? Finalized successfully! Completion summary email dispatched.`)
  }

  console.log('\n====================================================')
  console.log('ALL SCHEDULED SYNC TASKS FINISHED SUCCESSFULLY')
  console.log('====================================================')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal orchestrator error:', err)
  process.exit(1)
})
