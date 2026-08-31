/**
 * Regression Test Suite: Products Page SQL, Pagination, Serialization, and Override Counts
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const { Pool } = require('pg')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('ERROR: DATABASE_URL is not set.')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
})

let passedCount = 0
let failedCount = 0

function assert(condition, message, details = '') {
  if (condition) {
    console.log(`  ✓ ${message}` + (details ? ` [${details}]` : ''))
    passedCount++
  } else {
    console.error(`  ✗ FAIL: ${message}` + (details ? ` [${details}]` : ''))
    failedCount++
  }
}

async function runRegression() {
  const client = await pool.connect()
  try {
    console.log('====================================================')
    console.log('RUNNING PRODUCT PAGE SQL & SERIALIZATION REGRESSION')
    console.log('====================================================\n')

    const storeId = 4

    // 1. Full SQL query execution
    console.log('--- 1. SQL QUERY EXECUTION ---')
    const sql = `
      SELECT p.id, p.sku, p.name, p.price, p.regular_price, p.sale_price, p.stock_quantity,
             p.status, p.created_at, p.reviewed_at, p.brand, p.categories, p.images, ps.woo_product_id,
             ps.status AS store_status, ps.removed_at,
             COALESCE(v.variant_count, 0) as variant_count,
             v.min_cost_price,
             v.first_variant_image,
             ven.name AS vendor_name,
             psp.override_type,
             psp.custom_markup_percent,
             psp.fixed_price,
             COALESCE(vsp.variation_override_count, 0)::int AS variation_override_count
      FROM products p
      LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
      LEFT JOIN product_store_pricing psp ON psp.product_id = p.id AND psp.store_id = $1
      LEFT JOIN (
        SELECT product_id, store_id, COUNT(*) AS variation_override_count
        FROM variation_store_pricing
        WHERE override_type IN ('custom_markup', 'fixed_price')
        GROUP BY product_id, store_id
      ) vsp ON vsp.product_id = p.id AND vsp.store_id = $1
      LEFT JOIN vendors ven ON ven.id = p.vendor_id
      LEFT JOIN (
        SELECT product_id,
               COUNT(*) as variant_count,
               MIN(COALESCE(regular_price, price)) as min_cost_price,
               MIN(CASE WHEN image IS NOT NULL AND image != '' THEN image ELSE NULL END) as first_variant_image
        FROM product_variations
        GROUP BY product_id
      ) v ON v.product_id = p.id
      ORDER BY p.created_at DESC
      LIMIT $2 OFFSET $3
    `

    const page1Res = await client.query(sql, [storeId, 25, 0])
    assert(page1Res.rows.length === 25, 'Page 1 returns exact limit 25 products', page1Res.rows.length)

    // 2. Check duplicate product rows
    console.log('\n--- 2. DUPLICATE CHECK ---')
    const ids = page1Res.rows.map((r) => r.id)
    const uniqueIds = new Set(ids)
    assert(ids.length === uniqueIds.size, 'No duplicate product rows returned by subqueries/joins', `${ids.length} rows, ${uniqueIds.size} unique`)

    // 3. Test AT001 variation override count calculation
    console.log('\n--- 3. VARIATION OVERRIDE COUNT CALCULATION ---')
    // Set 2 variation overrides for AT001
    const at001 = (await client.query("SELECT id FROM products WHERE sku = 'AT001' LIMIT 1")).rows[0]
    if (at001) {
      const vars = (await client.query("SELECT id FROM product_variations WHERE product_id = $1 LIMIT 2", [at001.id])).rows
      if (vars.length >= 2) {
        await client.query(`
          INSERT INTO variation_store_pricing (store_id, product_id, variation_id, override_type, custom_markup_percent, updated_at)
          VALUES ($1, $2, $3, 'custom_markup', 250, CURRENT_TIMESTAMP)
          ON CONFLICT (store_id, variation_id)
          DO UPDATE SET override_type = 'custom_markup', custom_markup_percent = 250
        `, [storeId, at001.id, vars[0].id])

        await client.query(`
          INSERT INTO variation_store_pricing (store_id, product_id, variation_id, override_type, fixed_price, updated_at)
          VALUES ($1, $2, $3, 'fixed_price', 14.99, CURRENT_TIMESTAMP)
          ON CONFLICT (store_id, variation_id)
          DO UPDATE SET override_type = 'fixed_price', fixed_price = 14.99
        `, [storeId, at001.id, vars[1].id])

        const at001Res = await client.query(
          `SELECT p.id, p.sku, COALESCE(vsp.variation_override_count, 0)::int AS variation_override_count
           FROM products p
           LEFT JOIN (
             SELECT product_id, store_id, COUNT(*) AS variation_override_count
             FROM variation_store_pricing
             WHERE override_type IN ('custom_markup', 'fixed_price')
             GROUP BY product_id, store_id
           ) vsp ON vsp.product_id = p.id AND vsp.store_id = $1
           WHERE p.id = $2`,
          [storeId, at001.id]
        )
        assert(at001Res.rows[0].variation_override_count === 2, 'AT001 reflects exactly 2 variation overrides in SQL query', at001Res.rows[0].variation_override_count)

        // Cleanup AT001 overrides
        await client.query('DELETE FROM variation_store_pricing WHERE store_id = $1 AND product_id = $2', [storeId, at001.id])
        const cleanRes = await client.query(
          `SELECT p.id, p.sku, COALESCE(vsp.variation_override_count, 0)::int AS variation_override_count
           FROM products p
           LEFT JOIN (
             SELECT product_id, store_id, COUNT(*) AS variation_override_count
             FROM variation_store_pricing
             WHERE override_type IN ('custom_markup', 'fixed_price')
             GROUP BY product_id, store_id
           ) vsp ON vsp.product_id = p.id AND vsp.store_id = $1
           WHERE p.id = $2`,
          [storeId, at001.id]
        )
        assert(cleanRes.rows[0].variation_override_count === 0, 'Cleaned AT001 reflects 0 variation overrides', cleanRes.rows[0].variation_override_count)
      }
    }

    // 4. Server Component Serialization Check
    console.log('\n--- 4. SERVER COMPONENT SERIALIZATION CHECK ---')
    const normalizedProducts = page1Res.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      variant_count: Number(row.variant_count || 0),
      min_cost_price: row.min_cost_price !== null && row.min_cost_price !== undefined ? Number(row.min_cost_price) : null,
      custom_markup_percent: row.custom_markup_percent !== null && row.custom_markup_percent !== undefined ? Number(row.custom_markup_percent) : null,
      fixed_price: row.fixed_price !== null && row.fixed_price !== undefined ? Number(row.fixed_price) : null,
      variation_override_count: Number(row.variation_override_count || 0),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      removed_at: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    }))

    const jsonString = JSON.stringify(normalizedProducts)
    const parsedBack = JSON.parse(jsonString)
    assert(parsedBack.length === 25, 'All 25 rows successfully serialized across Server Component boundary', `${jsonString.length} bytes`)
    assert(typeof parsedBack[0].variation_override_count === 'number', 'variation_override_count serialized as plain number')

    console.log('\n====================================================')
    console.log(`PRODUCT PAGE REGRESSION RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`)
    console.log('====================================================')

    if (failedCount > 0) process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

runRegression().catch(console.error)
