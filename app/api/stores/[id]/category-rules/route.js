import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { toNumber } from '../../../../lib/pricing'

/**
 * GET /api/stores/[id]/category-rules
 * Returns all configured category pricing rules for the store + available product categories.
 */
export async function GET(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const storeId = parseInt(id, 10)

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    let rules = []
    try {
      const rulesRes = await db.query(
        `SELECT id, store_id, category, markup_percent, priority, active, created_at, updated_at
         FROM store_category_pricing_rules
         WHERE store_id = $1
         ORDER BY priority ASC, id ASC`,
        [storeId]
      )
      rules = rulesRes.rows.map((r) => ({
        id: r.id,
        store_id: r.store_id,
        category: r.category,
        markup_percent: Number(r.markup_percent),
        priority: Number(r.priority) || 0,
        active: r.active,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    } catch {
      rules = []
    }

    // Fetch distinct available categories for this store
    let availableCategories = []
    try {
      const catRes = await db.query(
        `SELECT DISTINCT p.categories
         FROM products p
         LEFT JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1
         WHERE (p.store_id = $1 OR vs.store_id = $1) AND p.categories IS NOT NULL AND p.categories != ''`,
        [storeId]
      )
      const catSet = new Set()
      catRes.rows.forEach((row) => {
        if (row.categories) {
          String(row.categories)
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
            .forEach((c) => catSet.add(c))
        }
      })
      availableCategories = Array.from(catSet).sort((a, b) => a.localeCompare(b))
    } catch {
      availableCategories = []
    }

    return NextResponse.json({
      store_id: storeId,
      rules,
      available_categories: availableCategories,
    })
  } catch (error) {
    console.error('Error fetching category pricing rules:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/stores/[id]/category-rules (ATOMIC BULK SAVE)
 * Replaces the complete set of category pricing rules inside a transaction.
 */
export async function PUT(request, { params }) {
  let client
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id } = await params
    const storeId = parseInt(id, 10)

    if (session.user.role !== 'super_admin') {
      const hasAccess = await verifyAdminStoreAccess(db, session.user.id, storeId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
      }
    }

    const body = await request.json().catch(() => ({}))
    const rawRules = Array.isArray(body.rules) ? body.rules : []

    // 1. Sanitize & Validate
    const seenCategories = new Set()
    const sanitized = []

    for (let i = 0; i < rawRules.length; i++) {
      const r = rawRules[i]
      const cat = String(r.category || '').trim()
      if (!cat) {
        return NextResponse.json(
          { error: `Rule #${i + 1}: Category name is required.` },
          { status: 400 }
        )
      }

      const lowerCat = cat.toLowerCase()
      if (seenCategories.has(lowerCat)) {
        return NextResponse.json(
          { error: `Duplicate category "${cat}" detected. Each category can only have one pricing rule.` },
          { status: 400 }
        )
      }
      seenCategories.add(lowerCat)

      const markup = toNumber(r.markup_percent)
      if (markup === null || markup < 0) {
        return NextResponse.json(
          { error: `Rule #${i + 1} ("${cat}"): Markup percent must be a non-negative number.` },
          { status: 400 }
        )
      }

      sanitized.push({
        category: cat,
        markup_percent: markup,
        priority: i + 1, // 1-indexed order based on table sequence
        active: r.active !== false,
      })
    }

    // 2. Atomic Transaction
    client = await db.pool.connect()
    await client.query('BEGIN')

    await client.query('DELETE FROM store_category_pricing_rules WHERE store_id = $1', [storeId])

    const insertedRules = []
    for (let i = 0; i < sanitized.length; i++) {
      const r = sanitized[i]
      const insertRes = await client.query(
        `INSERT INTO store_category_pricing_rules (store_id, category, markup_percent, priority, active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, store_id, category, markup_percent, priority, active, created_at, updated_at`,
        [storeId, r.category, r.markup_percent, r.priority, r.active]
      )
      insertedRules.push({
        id: insertRes.rows[0].id,
        store_id: insertRes.rows[0].store_id,
        category: insertRes.rows[0].category,
        markup_percent: Number(insertRes.rows[0].markup_percent),
        priority: Number(insertRes.rows[0].priority),
        active: insertRes.rows[0].active,
        created_at: insertRes.rows[0].created_at,
        updated_at: insertRes.rows[0].updated_at,
      })
    }

    await client.query('COMMIT')

    return NextResponse.json({
      success: true,
      store_id: storeId,
      rules: insertedRules,
      count: insertedRules.length,
    })
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {})
    }
    console.error('Error saving category pricing rules:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  } finally {
    if (client) {
      client.release()
    }
  }
}
