// Migration: makes a single product row visible to every store instead of
// being owned by exactly one. Adds a `product_stores` join table (mirrors
// the existing vendor_stores/admin_stores pattern) holding per-store
// status/reviewed_by/reviewed_at/woo_product_id, merges any product rows
// that already exist as separate per-store duplicates of the same SKU
// (store_id = 1 wins as canonical when a SKU exists in more than one store),
// fans every product out to every active store, then drops the now-obsolete
// per-store columns from `products`.
//
// Safe to re-run: every step is idempotent (IF NOT EXISTS / ON CONFLICT DO
// NOTHING / IF EXISTS), except it will no-op once the `products.store_id`
// column is already gone.

const { Pool } = require('pg')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
})

const STATUS_PRECEDENCE = { pending: 0, rejected: 1, approved: 2, synced: 3 }

function backupDatabase() {
  const backupDir = path.join(__dirname, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(backupDir, `pre-product-store-migration-${timestamp}.sql`)

  console.log(`Backing up products/product_variations/stores/csv_uploads to ${backupFile} ...`)
  const pgDumpBin = process.env.PG_DUMP_BIN || 'pg_dump'
  execFileSync(
    pgDumpBin,
    [
      process.env.DATABASE_URL,
      '-t', 'products',
      '-t', 'product_variations',
      '-t', 'stores',
      '-t', 'csv_uploads',
      '--no-owner',
      '--no-privileges',
      '-f', backupFile,
    ],
    // A dropped connection to Neon can otherwise leave pg_dump hanging
    // indefinitely on a dead socket read with no output and no error.
    { stdio: 'inherit', timeout: 10 * 60 * 1000, killSignal: 'SIGKILL' }
  )

  const { size } = fs.statSync(backupFile)
  if (size === 0) {
    throw new Error(`Backup file ${backupFile} is empty - aborting before touching the database.`)
  }
  console.log(`Backup OK (${size} bytes).`)
  return backupFile
}

async function dropUniqueConstraintOnColumns(client, table, columns) {
  const sorted = [...columns].sort()
  const { rows } = await client.query(
    `
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    WHERE tc.table_name = $1 AND tc.constraint_type = 'UNIQUE'
    GROUP BY tc.constraint_name
    HAVING array_agg(kcu.column_name::text ORDER BY kcu.column_name) = $2::text[]
    `,
    [table, sorted]
  )

  for (const row of rows) {
    console.log(`  Dropping constraint ${row.constraint_name} on ${table}...`)
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${row.constraint_name}"`)
  }
}

async function run() {
  backupDatabase()

  const client = await pool.connect()
  try {
    console.log('\nCapturing pre-migration counts...')
    const preTotal = (await client.query('SELECT COUNT(*) AS n FROM products')).rows[0].n
    const preStore1 = (
      await client.query("SELECT status, COUNT(*) AS n FROM products WHERE store_id = 1 GROUP BY status")
    ).rows
    console.log(`  products: ${preTotal}`)
    console.log('  store 1 status breakdown:', preStore1)

    await client.query('BEGIN')

    console.log('\nCreating product_stores...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_stores (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'synced')),
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        woo_product_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id, store_id)
      )
    `)
    await client.query('CREATE INDEX IF NOT EXISTS idx_product_stores_product_id ON product_stores(product_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_product_stores_store_id ON product_stores(store_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_product_stores_store_status ON product_stores(store_id, status)')

    console.log('\nBuilding canonical-product mapping (store 1 wins per SKU, else lowest store_id; null-sku products map to themselves)...')
    await client.query('DROP TABLE IF EXISTS sku_canonical')
    await client.query(`
      CREATE TEMP TABLE sku_canonical AS
      SELECT DISTINCT ON (sku) sku, id AS canonical_id
      FROM products
      WHERE sku IS NOT NULL AND sku != ''
      ORDER BY sku, (store_id <> 1), store_id, id
    `)
    await client.query('DROP TABLE IF EXISTS product_canonical_map')
    await client.query(`
      CREATE TEMP TABLE product_canonical_map AS
      SELECT p.id AS original_id, p.store_id AS original_store_id,
             COALESCE(sc.canonical_id, p.id) AS canonical_id
      FROM products p
      LEFT JOIN sku_canonical sc ON sc.sku = p.sku AND p.sku IS NOT NULL AND p.sku != ''
    `)

    const dupGroups = (
      await client.query('SELECT COUNT(DISTINCT canonical_id) AS n FROM product_canonical_map WHERE canonical_id != original_id')
    ).rows[0].n
    console.log(`  ${dupGroups} product(s) have duplicate rows in other stores that will be merged in.`)

    console.log('\nBackfilling product_stores from every original row\'s history...')
    const backfillResult = await client.query(`
      INSERT INTO product_stores (product_id, store_id, status, review_notes, reviewed_by, reviewed_at, woo_product_id, created_at, updated_at)
      SELECT pcm.canonical_id, p.store_id, p.status, p.review_notes, p.reviewed_by, p.reviewed_at, p.woo_product_id, p.created_at, p.updated_at
      FROM products p
      JOIN product_canonical_map pcm ON pcm.original_id = p.id
      ON CONFLICT (product_id, store_id) DO NOTHING
    `)
    console.log(`  ${backfillResult.rowCount} product_stores rows created from existing history.`)

    if (Number(backfillResult.rowCount) !== Number(preTotal)) {
      throw new Error(
        `Expected to backfill exactly ${preTotal} product_stores rows (one per original product row) but got ${backfillResult.rowCount}. Aborting.`
      )
    }

    console.log('\nMerging/reparenting variations of duplicate ("loser") product rows...')
    const { rows: loserMappings } = await client.query(
      'SELECT original_id, canonical_id FROM product_canonical_map WHERE canonical_id != original_id'
    )

    let reparented = 0
    let mergedForward = 0
    let discarded = 0
    const mergeReport = []

    for (const { original_id: loserId, canonical_id: canonicalId } of loserMappings) {
      const { rows: loserVariations } = await client.query(
        'SELECT * FROM product_variations WHERE product_id = $1',
        [loserId]
      )

      const report = { loserProductId: loserId, canonicalProductId: canonicalId, variations: [] }

      for (const v of loserVariations) {
        let matched = null
        if (v.sku) {
          const { rows: existingRows } = await client.query(
            'SELECT id, status FROM product_variations WHERE product_id = $1 AND sku = $2',
            [canonicalId, v.sku]
          )
          matched = existingRows[0] || null
        }

        if (matched) {
          const loserRank = STATUS_PRECEDENCE[v.status] ?? 0
          const canonicalRank = STATUS_PRECEDENCE[matched.status] ?? 0
          if (loserRank > canonicalRank) {
            await client.query(
              'UPDATE product_variations SET status = $1, woo_variation_id = $2, updated_at = NOW() WHERE id = $3',
              [v.status, v.woo_variation_id, matched.id]
            )
            mergedForward++
            report.variations.push({ sku: v.sku, action: 'merged_forward', fromStatus: matched.status, toStatus: v.status })
          } else {
            discarded++
            report.variations.push({ sku: v.sku, action: 'discarded', keptStatus: matched.status })
          }
        } else {
          await client.query('UPDATE product_variations SET product_id = $1 WHERE id = $2', [canonicalId, v.id])
          reparented++
          report.variations.push({ sku: v.sku, action: 'reparented' })
        }
      }

      mergeReport.push(report)
    }

    console.log(`  ${reparented} variation(s) reparented onto canonical products.`)
    console.log(`  ${mergedForward} variation(s) had their more-advanced status/woo_variation_id merged forward.`)
    console.log(`  ${discarded} duplicate variation(s) discarded (canonical copy already as advanced or more).`)

    const reportDir = path.join(__dirname, 'backups')
    const reportFile = path.join(reportDir, `merge-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(reportFile, JSON.stringify(mergeReport, null, 2))
    console.log(`  Merge report written to ${reportFile}`)

    console.log('\nDeleting duplicate ("loser") product rows...')
    const loserIds = loserMappings.map((m) => m.original_id)
    if (loserIds.length > 0) {
      const deleted = await client.query('DELETE FROM products WHERE id = ANY($1::int[])', [loserIds])
      console.log(`  ${deleted.rowCount} duplicate product row(s) deleted.`)
    } else {
      console.log('  No duplicates to delete.')
    }

    console.log('\nFanning every product out to every active store...')
    const fanoutResult = await client.query(`
      INSERT INTO product_stores (product_id, store_id, status)
      SELECT p.id, s.id, 'pending'
      FROM products p CROSS JOIN stores s
      WHERE s.status = 'active'
      ON CONFLICT (product_id, store_id) DO NOTHING
    `)
    console.log(`  ${fanoutResult.rowCount} new (product, store) pairs added as 'pending'.`)

    console.log('\nVerifying every canonical product has a product_stores row for every active store...')
    const gaps = (
      await client.query(`
        SELECT COUNT(*) AS n
        FROM products p, stores s
        WHERE s.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM product_stores ps WHERE ps.product_id = p.id AND ps.store_id = s.id)
      `)
    ).rows[0].n
    if (Number(gaps) !== 0) {
      throw new Error(`${gaps} (product, active store) pairs are missing a product_stores row. Aborting before dropping columns.`)
    }

    const postStore1 = (
      await client.query("SELECT status, COUNT(*) AS n FROM product_stores WHERE store_id = 1 GROUP BY status")
    ).rows
    console.log('  store 1 status breakdown after merge (should match pre-migration exactly):', postStore1)

    console.log('\nAll checks passed. Dropping obsolete per-store columns from products...')
    await dropUniqueConstraintOnColumns(client, 'products', ['store_id', 'sku'])
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS store_id CASCADE')
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS status CASCADE')
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS review_notes CASCADE')
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS reviewed_by CASCADE')
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS reviewed_at CASCADE')
    await client.query('ALTER TABLE products DROP COLUMN IF EXISTS woo_product_id CASCADE')

    console.log('Adding global UNIQUE(sku) on products...')
    try {
      await client.query('ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku)')
    } catch (e) {
      if (e.code !== '42P07') throw e
      console.log('  (constraint already exists)')
    }

    await client.query('COMMIT')

    const finalProducts = (await client.query('SELECT COUNT(*) AS n FROM products')).rows[0].n
    const finalProductStores = (await client.query('SELECT COUNT(*) AS n FROM product_stores')).rows[0].n
    console.log('\nMigration completed successfully.')
    console.log(`  products: ${finalProducts}`)
    console.log(`  product_stores: ${finalProductStores}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('\nMigration failed, rolled back:', err)
  process.exit(1)
})
