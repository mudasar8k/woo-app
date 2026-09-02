/**
 * Automated test suite for batched/resumable Ralawise sync.
 * Run with: node scripts/test-ralawise-batched-sync.js
 */

require('dotenv').config({ path: '.env.local' })
const fs = require('fs')
const db = require('../app/lib/db')
const {
  ensureJobsTable,
  getSyncJob,
  updateSyncJob,
  createSyncJob,
  getActiveSyncJobForStore,
  serializeJob,
  JOB_STATUS,
} = require('../app/lib/ralawise-sync-jobs')
const {
  prepareRalawiseSync,
  processParentBatch,
  processVariationBatch,
  finalizeRalawiseSync,
  resumeRalawiseSync,
} = require('../app/lib/ralawise-batch-importer')
const { lastImportPaths } = require('../app/lib/ralawise-import')

async function runTests() {
  console.log('============================================================')
  console.log('AUTOMATED TEST: RALAWISE BATCHED & RESUMABLE SYNC')
  console.log('============================================================\n')

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

  try {
    // 1. Database Schema
    console.log('--- Test 1: DB Schema & Jobs Table Initialization ---')
    await ensureJobsTable(db)
    const tableCheck = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ralawise_sync_jobs' AND column_name IN ('phase', 'parent_total', 'parent_cursor', 'variation_total', 'variation_cursor', 'cancel_requested')
    `)
    assert(tableCheck.rows.length >= 6, 'ralawise_sync_jobs has all batched cursor columns')

    // Find test store, vendor and user
    const storeRes = await db.query('SELECT id FROM stores LIMIT 1')
    const vendorRes = await db.query('SELECT id FROM vendors WHERE status = $1 LIMIT 1', ['active'])
    const userRes = await db.query('SELECT id FROM users LIMIT 1')
    if (storeRes.rows.length === 0 || vendorRes.rows.length === 0) {
      throw new Error('Test requires at least one store and active vendor in DB')
    }
    const storeId = storeRes.rows[0].id
    const vendorId = vendorRes.rows[0].id
    const userId = userRes.rows[0]?.id || null

    // Clear baseline files for test run
    const paths = lastImportPaths(vendorId)
    if (fs.existsSync(paths.parentCsvPath)) fs.unlinkSync(paths.parentCsvPath)
    if (fs.existsSync(paths.variationsCsvPath)) fs.unlinkSync(paths.variationsCsvPath)

    const runId = Date.now()
    const sku1 = `TBAT_${runId}_01`
    const sku2 = `TBAT_${runId}_02`
    const sku3 = `TBAT_${runId}_03`
    const sku4 = `TBAT_${runId}_04`
    const sku5 = `TBAT_${runId}_05`

    const sampleParentCsv = `Code,Name,Description,Commodity_Code,Origin_Country,Carton_Qty,Pack_Qty,Weight,Dimensions,Brand,Category,Gender,AgeGroup,Fabric,TagInformation,Accreditations,Organic,AvailableInPlusSizes,Size,Length_Fit,Style,Neckline,Sleeve,Fit
${sku1},Test Batch Product 1,Test Description 1,61091000,BD,72,12,150gsm,40x30x20,TestBrand,T-Shirts,Unisex,Adult,100% Cotton,Tearaway,WRAP,No,Yes,S-2XL,Regular,Casual,Crew,Short,Regular
${sku2},Test Batch Product 2,Test Description 2,61091000,BD,72,12,180gsm,40x30x20,TestBrand,T-Shirts,Unisex,Adult,100% Cotton,Tearaway,WRAP,No,Yes,S-2XL,Regular,Casual,Crew,Short,Regular
${sku3},Test Batch Product 3,Test Description 3,61091000,BD,72,12,200gsm,40x30x20,TestBrand,T-Shirts,Unisex,Adult,100% Cotton,Tearaway,WRAP,No,Yes,S-2XL,Regular,Casual,Crew,Short,Regular
${sku4},Test Batch Product 4,Test Description 4,61091000,BD,72,12,220gsm,40x30x20,TestBrand,T-Shirts,Unisex,Adult,100% Cotton,Tearaway,WRAP,No,Yes,S-2XL,Regular,Casual,Crew,Short,Regular
${sku5},Test Batch Product 5,Test Description 5,61091000,BD,72,12,240gsm,40x30x20,TestBrand,T-Shirts,Unisex,Adult,100% Cotton,Tearaway,WRAP,No,Yes,S-2XL,Regular,Casual,Crew,Short,Regular`

    const sampleVarCsv = `Primary_SKU,SKU,Colour,Primary_Colour,Size,Single_Price,Pack_Price,Carton_Price
${sku1},${sku1}_BLK_S,Black,Black,S,5.00,4.50,4.00
${sku1},${sku1}_BLK_M,Black,Black,M,5.00,4.50,4.00
${sku2},${sku2}_WHT_S,White,White,S,6.00,5.50,5.00
${sku2},${sku2}_WHT_M,White,White,M,6.00,5.50,5.00
${sku3},${sku3}_RED_S,Red,Red,S,7.00,6.50,6.00
${sku3},${sku3}_RED_M,Red,Red,M,7.00,6.50,6.00
${sku4},${sku4}_BLU_S,Blue,Blue,S,8.00,7.50,7.00
${sku4},${sku4}_BLU_M,Blue,Blue,M,8.00,7.50,7.00
${sku5},${sku5}_GRN_S,Green,Green,S,9.00,8.50,8.00
${sku5},${sku5}_GRN_M,Green,Green,M,9.00,8.50,8.00`

    // 2. Prepare Phase
    console.log('\n--- Test 2: Prepare Phase ---')
    const prepResult = await prepareRalawiseSync({
      storeId,
      vendorId,
      userId,
      db,
      files: {
        parentCsvText: sampleParentCsv,
        variationsCsvText: sampleVarCsv,
      },
    })

    assert(prepResult.ok === true, 'prepareRalawiseSync returns ok=true')
    assert(prepResult.jobId > 0, `prepareRalawiseSync creates jobId=${prepResult.jobId}`)
    assert(prepResult.phase === 'parents', 'Initial phase is parents')
    assert(prepResult.parent_total === 5, 'Parent total is 5')
    assert(prepResult.variation_total === 10, 'Variation total is 10')

    const jobId = prepResult.jobId

    // 3. Parent Batch 1 (Batch size = 2)
    console.log('\n--- Test 3: Parent Batch 1 (Size: 2) ---')
    const pBatch1 = await processParentBatch({ jobId, db, batchSize: 2 })
    assert(pBatch1.ok === true, 'Parent batch 1 succeeds')
    assert(pBatch1.parentProcessed === 2, `Parent processed count is 2 (got ${pBatch1.parentProcessed})`)
    assert(pBatch1.hasMore === true, 'hasMore is true')
    assert(pBatch1.phase === 'parents', 'Phase remains parents')

    // 4. Parent Batch 2 (Batch size = 2)
    console.log('\n--- Test 4: Parent Batch 2 (Size: 2) ---')
    const pBatch2 = await processParentBatch({ jobId, db, batchSize: 2 })
    assert(pBatch2.parentProcessed === 4, `Parent processed count is 4 (got ${pBatch2.parentProcessed})`)
    assert(pBatch2.hasMore === true, 'hasMore is true')

    // 5. Parent Batch 3 (Batch size = 2, final 1 item)
    console.log('\n--- Test 5: Parent Batch 3 (Finalizing parents) ---')
    const pBatch3 = await processParentBatch({ jobId, db, batchSize: 2 })
    assert(pBatch3.parentProcessed === 5, `All 5 parents processed (got ${pBatch3.parentProcessed})`)
    assert(pBatch3.hasMore === false, 'hasMore is false for parents')
    assert(pBatch3.phase === 'variations', 'Phase transitioned to variations')

    // 6. Variation Batch 1 (Batch size = 4)
    console.log('\n--- Test 6: Variation Batch 1 (Size: 4) ---')
    const vBatch1 = await processVariationBatch({ jobId, db, batchSize: 4 })
    assert(vBatch1.ok === true, 'Variation batch 1 succeeds')
    assert(vBatch1.variationProcessed === 4, `Variation processed count is 4 (got ${vBatch1.variationProcessed})`)
    assert(vBatch1.hasMore === true, 'hasMore is true for variations')
    assert(vBatch1.phase === 'variations', 'Phase remains variations')

    // 7. Stop / Pause Simulation
    console.log('\n--- Test 7: Stop / Cancellation Simulation ---')
    await updateSyncJob(db, jobId, { status: JOB_STATUS.PAUSED, cancel_requested: true })
    const pausedCheck = await processVariationBatch({ jobId, db, batchSize: 4 })
    assert(pausedCheck.paused === true, 'processVariationBatch respects paused/cancel_requested state')

    // 8. Explicit Resume Endpoint Simulation
    console.log('\n--- Test 8: Explicit Resume Endpoint Simulation ---')
    const resumedState = await resumeRalawiseSync({ jobId, db })
    assert(resumedState.cancelRequested === false, 'resumeRalawiseSync clears cancelRequested to false')
    assert(resumedState.status === JOB_STATUS.IMPORTING_VARIATIONS, 'Job status changes back to running (importing_variations)')
    assert(resumedState.variationCursor === 4, `variationCursor preserved at 4 (got ${resumedState.variationCursor})`)

    const vBatch2 = await processVariationBatch({ jobId, db, batchSize: 4 })
    assert(vBatch2.variationProcessed === 8, `Resumed variation batch 2 reaches 8 processed (got ${vBatch2.variationProcessed})`)
    assert(vBatch2.hasMore === true, 'hasMore is true')

    // 9. Variation Batch 3 (Final 2 items)
    console.log('\n--- Test 9: Variation Batch 3 (Finalizing variations) ---')
    const vBatch3 = await processVariationBatch({ jobId, db, batchSize: 4 })
    assert(vBatch3.variationProcessed === 10, `All 10 variations processed (got ${vBatch3.variationProcessed})`)
    assert(vBatch3.hasMore === false, 'hasMore is false for variations')
    assert(vBatch3.phase === 'finalize', 'Phase transitioned to finalize')

    // 10. Finalize Phase
    console.log('\n--- Test 10: Finalize Phase ---')
    const finResult = await finalizeRalawiseSync({ jobId, db })
    assert(finResult.ok === true, 'Finalize returns ok=true')
    assert(finResult.status === JOB_STATUS.COMPLETED, 'Job status is completed')

    const finalJob = await getSyncJob(db, jobId)
    assert(finalJob.status === JOB_STATUS.COMPLETED, 'Final DB job record is completed')
    assert(finalJob.parent_processed === 5, `Final parent_processed is 5 (got ${finalJob.parent_processed})`)
    assert(finalJob.variation_processed === 10, `Final variation_processed is 10 (got ${finalJob.variation_processed})`)

    // 11. Idempotent Retry Test
    console.log('\n--- Test 11: Idempotent Re-Run Safety Check ---')
    const dupCheck = await db.query(`
      SELECT sku, count(*) as cnt 
      FROM products 
      WHERE sku LIKE 'TBAT_${runId}_%' 
      GROUP BY sku 
      HAVING count(*) > 1
    `)
    assert(dupCheck.rows.length === 0, 'Zero duplicate products created')

    // 12. Legacy Paused Job Resume (Cursor 3,550 preservation test)
    console.log('\n--- Test 12: Legacy Paused Job State (3,550 preservation) ---')
    const mockLegacyJob = await createSyncJob(db, { storeId, vendorId, userId })
    await updateSyncJob(db, mockLegacyJob.id, {
      status: JOB_STATUS.PAUSED,
      step: 'importing_products',
      phase: 'prepare',
      current_count: 3550,
      total_count: 4264,
      cancel_requested: true,
      parent_cursor: 0,
      parent_processed: 0,
      parent_total: 0,
    })

    const migratedResume = await resumeRalawiseSync({
      jobId: mockLegacyJob.id,
      db,
      files: {
        parentCsvText: sampleParentCsv,
        variationsCsvText: sampleVarCsv,
      },
    })
    assert(migratedResume.cancelRequested === false, 'Legacy resume clears cancel_requested')
    assert(migratedResume.parentCursor === 3550, `Legacy resume preserves parent_cursor at 3550 (got ${migratedResume.parentCursor})`)
    assert(migratedResume.parentProcessed === 3550, `Legacy resume preserves parent_processed at 3550 (got ${migratedResume.parentProcessed})`)
    assert(migratedResume.parentTotal === 4264, `Legacy resume preserves parent_total at 4264 (got ${migratedResume.parentTotal})`)
    assert(migratedResume.phase === 'parents', 'Legacy resume sets phase to parents')
    assert(migratedResume.status === JOB_STATUS.IMPORTING_PRODUCTS, 'Legacy resume sets status to importing_products')

    // Double resume idempotency test
    const doubleResume = await resumeRalawiseSync({
      jobId: mockLegacyJob.id,
      db,
      files: {
        parentCsvText: sampleParentCsv,
        variationsCsvText: sampleVarCsv,
      },
    })
    assert(doubleResume.parentCursor === 3550, 'Double resume preserves existing cursor at 3550')

    // 13. Server-Side Active Job Discovery Tests
    console.log('\n--- Test 13: Server-Side Active Job Discovery ---')
    const activeDiscovered = await getActiveSyncJobForStore(db, storeId)
    assert(activeDiscovered !== null, 'getActiveSyncJobForStore discovers active/paused job')
    assert(activeDiscovered.id === mockLegacyJob.id, `Discovers latest non-terminal job (id=${mockLegacyJob.id})`)
    assert(activeDiscovered.status === JOB_STATUS.IMPORTING_PRODUCTS, 'Discovered job has active status')

    // Mark completed and verify exclusion
    await updateSyncJob(db, mockLegacyJob.id, { status: JOB_STATUS.COMPLETED })
    const excludedCompleted = await getActiveSyncJobForStore(db, storeId)
    // Should be null or another earlier job if exists
    assert(excludedCompleted?.id !== mockLegacyJob.id, 'Completed job is excluded from active discovery')

    // Mark failed and verify exclusion
    await updateSyncJob(db, mockLegacyJob.id, { status: JOB_STATUS.FAILED })
    const excludedFailed = await getActiveSyncJobForStore(db, storeId)
    assert(excludedFailed?.id !== mockLegacyJob.id, 'Failed job is excluded from active discovery')

    // Cleanup test fixtures
    await db.query(`DELETE FROM product_variations WHERE sku LIKE 'TBAT_${runId}_%'`)
    await db.query(`DELETE FROM products WHERE sku LIKE 'TBAT_${runId}_%'`)
    await db.query(`DELETE FROM ralawise_sync_jobs WHERE id IN ($1, $2)`, [jobId, mockLegacyJob.id])
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
