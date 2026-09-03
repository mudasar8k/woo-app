/**
 * Headless CLI / GitHub Actions runner for Ralawise Scheduled Sync.
 * Usage: node scripts/run-ralawise-headless-sync.js [--store=4] [--force]
 */

require('dotenv').config({ path: '.env.local' });
const db = require('../app/lib/db');
const {
  isScheduleDue,
  runHeadlessSync,
  getUkDateString,
  getUkTimeComponents,
} = require('../app/lib/ralawise-scheduler');
const { getActiveSyncJobForStore } = require('../app/lib/ralawise-sync-jobs');

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force');
  const storeArg = args.find((a) => a.startsWith('--store='));
  const targetStoreId = storeArg ? parseInt(storeArg.split('=')[1], 10) : 4;

  const ukDate = getUkDateString(new Date());
  const ukTime = getUkTimeComponents(new Date());

  console.log('====================================================');
  console.log('RALAWISE HEADLESS SCHEDULED SYNC RUNNER');
  console.log(`Current UK Time: ${String(ukTime.hour).padStart(2, '0')}:${String(ukTime.minute).padStart(2, '0')} (${ukDate})`);
  console.log(`Global Enabled Flag: ${process.env.RALAWISE_SYNC_SCHEDULE_ENABLED}`);
  console.log('====================================================');

  const storeRes = await db.query('SELECT * FROM stores WHERE id = $1', [targetStoreId]);
  if (storeRes.rows.length === 0) {
    console.error(`Store ${targetStoreId} not found.`);
    process.exit(1);
  }

  const store = storeRes.rows[0];
  console.log(`Target Store: ${store.name} (ID: ${store.id})`);
  console.log(`Auto Sync Enabled: ${store.ralawise_auto_sync_enabled}`);
  console.log(`Configured Sync Time: ${store.ralawise_sync_time || '14:00'} (Europe/London)`);
  console.log(`Notification Emails: ${store.ralawise_sync_notify_emails || 'None'}`);

  if (!isForce) {
    // Check latest scheduled job today
    const lastJobTodayRes = await db.query(
      `SELECT id, status, phase, created_at
       FROM ralawise_sync_jobs
       WHERE store_id = $1 AND trigger_source = 'scheduled' AND scheduled_for = $2
       ORDER BY id DESC LIMIT 1`,
      [store.id, ukDate]
    );
    const lastScheduledJobToday = lastJobTodayRes.rows[0] || null;

    // Check active job
    const activeJob = await getActiveSyncJobForStore(db, store.id);

    const check = isScheduleDue({
      store,
      now: new Date(),
      lastScheduledJobToday,
      activeJob,
    });

    if (!check.isDue) {
      console.log(`\n[SKIP] Sync is not due: ${check.reason}`);
      process.exit(0);
    }
  } else {
    console.log('\n[INFO] --force flag provided. Bypassing schedule time check.');
  }

  console.log('\n[START] Launching headless Ralawise synchronization...');
  const result = await runHeadlessSync(db, { store, vendorId: 1 });

  console.log('\n====================================================');
  console.log('SYNC RUN RESULT:', JSON.stringify(result, null, 2));
  console.log('====================================================');

  if (!result.ok && !result.paused) {
    console.error('Sync failed with error:', result.error);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error in headless runner:', err);
  process.exit(1);
});
