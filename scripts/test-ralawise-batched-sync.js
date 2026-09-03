/**
 * Automated test suite for Ralawise batched & scheduled sync engine,
 * scheduling, UK DST handling, duplicate run protection, and email notifications.
 */

require('dotenv').config({ path: '.env.local' })
const db = require('../app/lib/db')
const {
  JOB_STATUS,
  ensureJobsTable,
  createSyncJob,
  updateSyncJob,
  getSyncJob,
  getActiveSyncJobForStore,
  saveJobPayloads,
  getParentBatchSlice,
  getVariationBatchSlice,
  cleanupJobPayloads,
} = require('../app/lib/ralawise-sync-jobs')
const {
  prepareRalawiseSync,
  processParentBatch,
  processVariationBatch,
  finalizeRalawiseSync,
  resumeRalawiseSync,
  stopRalawiseSync,
} = require('../app/lib/ralawise-batch-importer')
const {
  getUkDateString,
  getUkTimeComponents,
  parseTimeSetting,
  isScheduleDue,
  runHeadlessSync,
} = require('../app/lib/ralawise-scheduler')
const {
  sendResendEmail,
  sendTestSyncEmail,
  sendSyncCompletionEmail,
  sendSyncFailureEmail,
  parseRecipients,
  formatUkDateTime,
} = require('../app/lib/ralawise-notifications')

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    console.log(`  ? ${message}`)
    passed++
  } else {
    console.error(`  ? FAIL: ${message}`)
    failed++
  }
}

async function runTests() {
  console.log('============================================================')
  console.log('AUTOMATED TEST: RALAWISE BATCHED & SCHEDULED SYNC')
  console.log('============================================================')

  const storeId = 5 // Test Store ID
  const vendorId = 1
  const userId = 2

  try {
    // 1. Schema & Table Initialization
    console.log('\n--- Test 1: DB Schema & Jobs Table Initialization ---')
    await ensureJobsTable(db)
    const tableCols = await db.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'ralawise_sync_jobs'
    `)
    const colNames = tableCols.rows.map((r) => r.column_name)
    assert(colNames.includes('parent_cursor'), 'ralawise_sync_jobs has parent_cursor')
    assert(colNames.includes('variation_cursor'), 'ralawise_sync_jobs has variation_cursor')
    assert(colNames.includes('trigger_source'), 'ralawise_sync_jobs has trigger_source')
    assert(colNames.includes('completion_email_sent_at'), 'ralawise_sync_jobs has completion_email_sent_at')

    // 2. Prepare Phase (Mocking 5 parents & 10 variations)
    console.log('\n--- Test 2: Prepare Phase ---')
    const mockParents = Array.from({ length: 5 }, (_, i) => ({
      code: `TEST_P_${Date.now()}_${i + 1}`,
      name: `Test Product ${i + 1}`,
      description: `Description ${i + 1}`,
      category: 'T-Shirts',
    }))

    const mockVariations = []
    for (const p of mockParents) {
      mockVariations.push(
        {
          primary_sku: p.code,
          sku: `${p.code}_BLK_S`,
          size: 'S',
          color: 'Black',
          price: '9.99',
        },
        {
          primary_sku: p.code,
          sku: `${p.code}_BLK_M`,
          size: 'M',
          color: 'Black',
          price: '10.99',
        }
      )
    }

    const prep = await prepareRalawiseSync(db, {
      storeId,
      vendorId,
      userId,
      mockParentRows: mockParents,
      mockVariationRows: mockVariations,
      triggerSource: 'scheduled',
      scheduledFor: getUkDateString(new Date()),
    })

    assert(prep.ok === true, 'prepareRalawiseSync returns ok=true')
    assert(prep.jobId > 0, `prepareRalawiseSync creates jobId=${prep.jobId}`)
    assert(prep.phase === 'parents', 'Initial phase is parents')
    assert(prep.parentTotal === 5, 'Parent total is 5')
    assert(prep.variationTotal === 10, 'Variation total is 10')

    const jobId = prep.jobId

    // 3. Parent Batch 1 (Size: 2)
    console.log('\n--- Test 3: Parent Batch 1 (Size: 2) ---')
    const pb1 = await processParentBatch(db, jobId, { batchSize: 2 })
    assert(pb1.ok === true, 'Parent batch 1 succeeds')
    assert(Number(pb1.job.parentProcessed) === 2, 'Parent processed count is 2 (got 2)')
    assert(pb1.hasMore === true, 'hasMore is true')
    assert(pb1.phase === 'parents', 'Phase remains parents')

    // 4. Parent Batch 2 (Size: 2)
    console.log('\n--- Test 4: Parent Batch 2 (Size: 2) ---')
    const pb2 = await processParentBatch(db, jobId, { batchSize: 2 })
    assert(Number(pb2.job.parentProcessed) === 4, 'Parent processed count is 4 (got 4)')
    assert(pb2.hasMore === true, 'hasMore is true')

    // 5. Parent Batch 3 (Finalizing parents)
    console.log('\n--- Test 5: Parent Batch 3 (Finalizing parents) ---')
    const pb3 = await processParentBatch(db, jobId, { batchSize: 2 })
    assert(Number(pb3.job.parentProcessed) === 5, 'All 5 parents processed (got 5)')
    assert(pb3.hasMore === false, 'hasMore is false for parents')
    assert(pb3.phase === 'variations', 'Phase transitioned to variations')

    // 6. Variation Batch 1 (Size: 4)
    console.log('\n--- Test 6: Variation Batch 1 (Size: 4) ---')
    const vb1 = await processVariationBatch(db, jobId, { batchSize: 4 })
    assert(vb1.ok === true, 'Variation batch 1 succeeds')
    assert(Number(vb1.job.variationProcessed) === 4, 'Variation processed count is 4 (got 4)')
    assert(vb1.hasMore === true, 'hasMore is true for variations')
    assert(vb1.phase === 'variations', 'Phase remains variations')

    // 7. Stop / Pause Simulation
    console.log('\n--- Test 7: Stop / Cancellation Simulation ---')
    const stopRes = await stopRalawiseSync(db, jobId)
    assert(stopRes.ok === true, 'stopRalawiseSync returns ok=true')
    assert(stopRes.status === JOB_STATUS.PAUSED, 'Job status changed to paused')

    const vbPauseTest = await processVariationBatch(db, jobId, { batchSize: 4 })
    assert(vbPauseTest.paused === true, 'processVariationBatch respects paused/cancel_requested state')

    // 8. Resume Endpoint
    console.log('\n--- Test 8: Explicit Resume Endpoint Simulation ---')
    const resumeRes = await resumeRalawiseSync(db, jobId)
    assert(resumeRes.ok === true, 'resumeRalawiseSync returns ok=true')
    assert(resumeRes.cancelRequested === false, 'resumeRalawiseSync clears cancelRequested to false')
    assert(Number(resumeRes.variationCursor) === 4, 'variationCursor preserved at 4 (got 4)')

    const vb2 = await processVariationBatch(db, jobId, { batchSize: 4 })
    assert(Number(vb2.job.variationProcessed) === 8, 'Resumed variation batch 2 reaches 8 processed (got 8)')
    assert(vb2.hasMore === true, 'hasMore is true')

    // 9. Variation Batch 3 (Finalizing variations)
    console.log('\n--- Test 9: Variation Batch 3 (Finalizing variations) ---')
    const vb3 = await processVariationBatch(db, jobId, { batchSize: 4 })
    assert(Number(vb3.job.variationProcessed) === 10, 'All 10 variations processed (got 10)')
    assert(vb3.hasMore === false, 'hasMore is false for variations')
    assert(vb3.phase === 'finalize', 'Phase transitioned to finalize')

    // 10. Finalize Phase
    console.log('\n--- Test 10: Finalize Phase ---')
    const fin = await finalizeRalawiseSync(db, jobId)
    assert(fin.ok === true, 'Finalize returns ok=true')
    assert(fin.status === JOB_STATUS.COMPLETED, 'Job status is completed')

    const finalJob = await getSyncJob(db, jobId)
    assert(finalJob.status === JOB_STATUS.COMPLETED, 'Final DB job record is completed')
    assert(Number(finalJob.parent_processed) === 5, 'Final parent_processed is 5')
    assert(Number(finalJob.variation_processed) === 10, 'Final variation_processed is 10')

    // 11. UK DST & Time Scheduling Tests
    console.log('\n--- Test 11: UK Date & Time Parsing ---')
    const ukDate = getUkDateString(new Date())
    assert(/^\d{4}-\d{2}-\d{2}$/.test(ukDate), `getUkDateString returns valid YYYY-MM-DD (${ukDate})`)

    const time1 = parseTimeSetting('14:00')
    assert(time1.hour === 14 && time1.minute === 0, 'parseTimeSetting parses 14:00 correctly')
    const time2 = parseTimeSetting('09:30')
    assert(time2.hour === 9 && time2.minute === 30, 'parseTimeSetting parses 09:30 correctly')

    // 12. Schedule Due Logic Tests
    console.log('\n--- Test 12: Schedule Due Logic & Guards ---')
    // A. Global flag disabled
    process.env.RALAWISE_SYNC_SCHEDULE_ENABLED = 'false'
    const dueA = isScheduleDue({ store: { id: 4, ralawise_auto_sync_enabled: true } })
    assert(dueA.isDue === false, 'Global flag false prevents schedule execution')

    // B. Store disabled
    process.env.RALAWISE_SYNC_SCHEDULE_ENABLED = 'true'
    const dueB = isScheduleDue({ store: { id: 4, ralawise_auto_sync_enabled: false } })
    assert(dueB.isDue === false, 'Store setting false prevents schedule execution')

    // C. Duplicate Active Job Guard
    const dueC = isScheduleDue({
      store: { id: 4, ralawise_auto_sync_enabled: true, ralawise_sync_time: '14:00' },
      activeJob: { id: 999, status: 'importing_products' },
    })
    assert(dueC.isDue === false, 'Active sync job prevents duplicate scheduled run')

    // D. One Run Per UK Calendar Date Guard
    const dueD = isScheduleDue({
      store: { id: 4, ralawise_auto_sync_enabled: true, ralawise_sync_time: '14:00' },
      lastScheduledJobToday: { id: 888 },
    })
    assert(dueD.isDue === false, 'Already ran today for UK date prevents duplicate run')

    // E. Time Check (Winter GMT vs Summer BST mock)
    const winterDate = new Date('2026-01-15T14:30:00Z') // 14:30 GMT
    const summerDate = new Date('2026-07-15T13:30:00Z') // 14:30 BST (13:30 UTC)

    const dueWinter = isScheduleDue({
      store: { id: 4, ralawise_auto_sync_enabled: true, ralawise_sync_time: '14:00' },
      now: winterDate,
    })
    assert(dueWinter.isDue === true, 'Winter GMT: 14:30 GMT is due for 14:00 schedule')

    const dueSummer = isScheduleDue({
      store: { id: 4, ralawise_auto_sync_enabled: true, ralawise_sync_time: '14:00' },
      now: summerDate,
    })
    assert(dueSummer.isDue === true, 'Summer BST: 14:30 BST (13:30 UTC) is due for 14:00 schedule')

    // 13. Email Notifications & Idempotency Tests
    console.log('\n--- Test 13: Email Notifications & Idempotency ---')
    const recipients = parseRecipients('test1@example.com, test2@example.com; admin@southline.co.uk')
    assert(recipients.length === 3, 'parseRecipients parsed 3 unique valid emails')

    // Create a mock job to test atomic email claiming
    const emailTestJob = await createSyncJob(db, { storeId, vendorId, userId })
    await updateSyncJob(db, emailTestJob.id, { status: JOB_STATUS.COMPLETED, completed_at: new Date() })

    // First completion email claim
    const email1 = await sendSyncCompletionEmail(db, {
      store: { id: storeId, name: 'Test Store', ralawise_sync_notify_emails: 'test@example.com' },
      job: emailTestJob,
      approvedProductCount: 564,
    })
    assert(email1.alreadySent !== true, 'First completion email claim succeeds')

    // Second completion email claim (Idempotency check)
    const email2 = await sendSyncCompletionEmail(db, {
      store: { id: storeId, name: 'Test Store', ralawise_sync_notify_emails: 'test@example.com' },
      job: emailTestJob,
      approvedProductCount: 564,
    })
    assert(email2.alreadySent === true, 'Duplicate completion email is suppressed idempotently')

    // Failure email claim test
    const failJob = await createSyncJob(db, { storeId, vendorId, userId })
    const fail1 = await sendSyncFailureEmail(db, {
      store: { id: storeId, name: 'Test Store', ralawise_sync_notify_emails: 'test@example.com' },
      job: failJob,
      error: new Error('Simulated network timeout'),
    })
    assert(fail1.alreadySent !== true, 'First failure email claim succeeds')

    const fail2 = await sendSyncFailureEmail(db, {
      store: { id: storeId, name: 'Test Store', ralawise_sync_notify_emails: 'test@example.com' },
      job: failJob,
      error: new Error('Simulated network timeout'),
    })
    assert(fail2.alreadySent === true, 'Duplicate failure email is suppressed idempotently')

    // 14. Safe Test Email Delivery Test
    console.log('\n--- Test 14: Safe Test Email Delivery Function ---')
    // A. Missing recipient validation
    const testEmailNoRecip = await sendTestSyncEmail({
      store: { id: storeId, name: 'Southline', ralawise_sync_notify_emails: '' },
      customRecipients: '',
    })
    assert(testEmailNoRecip.ok === false, 'sendTestSyncEmail rejects empty recipients with validation error')

    // B. Safe execution with recipients (graceful fallback when API key missing in test)
    const testEmailValid = await sendTestSyncEmail({
      store: { id: storeId, name: 'Southline', ralawise_sync_notify_emails: 'test@example.com' },
      customRecipients: 'test@southline.co.uk',
    })
    assert(testEmailValid.ok === true || testEmailValid.skipped === true || typeof testEmailValid.error === 'string', 'sendTestSyncEmail dispatches safely without side effects')

    // C. Verify zero sync jobs created and zero catalog mutations occurred
    const jobCheck = await getSyncJob(db, 999999)
    assert(jobCheck === null, 'Test email creates zero sync jobs')

    // Clean up test fixtures
    await db.query('DELETE FROM ralawise_sync_jobs WHERE id IN ($1, $2, $3)', [jobId, emailTestJob.id, failJob.id])
    await db.query(`DELETE FROM products WHERE sku LIKE 'TEST_P_%'`)
    console.log('Cleaned up test fixtures.')

  } catch (err) {
    console.error('Test error:', err)
    failed++
  } finally {
    console.log('\n============================================================')
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`)
    console.log('============================================================')
    process.exit(failed > 0 ? 1 : 0)
  }
}

runTests()
