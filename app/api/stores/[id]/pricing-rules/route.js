import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { validatePricingRules, sortPricingRules, toNumber } from '../../../../lib/pricing'

/**
 * GET /api/stores/[id]/pricing-rules
 * Returns all pricing rules for a store + live validation metadata.
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
        `SELECT id, store_id, min_cost, max_cost, markup_percent, sort_order, active, created_at, updated_at
         FROM store_pricing_rules
         WHERE store_id = $1
         ORDER BY min_cost ASC, sort_order ASC`,
        [storeId]
      )
      rules = rulesRes.rows.map((r) => ({
        id: r.id,
        store_id: r.store_id,
        min_cost: Number(r.min_cost),
        max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
        markup_percent: Number(r.markup_percent),
        sort_order: r.sort_order,
        active: r.active,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    } catch {
      rules = []
    }

    const validation = validatePricingRules(rules)

    return NextResponse.json({
      store_id: storeId,
      rules,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        hasGaps: validation.hasGaps,
        gaps: validation.gaps,
      },
    })
  } catch (error) {
    console.error('Error fetching store pricing rules:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/stores/[id]/pricing-rules (ATOMIC BULK SAVE)
 * Validates the complete proposed rule array, begins a transaction, replaces existing rules,
 * and commits. On validation or query failure, rolls back completely.
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

    // 1. Sanitize & Validate proposed rule set
    const sanitizedRules = rawRules.map((r, idx) => ({
      min_cost: toNumber(r.min_cost) ?? 0,
      max_cost: r.max_cost !== null && r.max_cost !== undefined && r.max_cost !== '' ? toNumber(r.max_cost) : null,
      markup_percent: toNumber(r.markup_percent) ?? 0,
      sort_order: idx,
      active: r.active !== false,
    }))

    const validation = validatePricingRules(sanitizedRules)
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: 'Pricing rules validation failed',
          details: validation.errors,
        },
        { status: 400 }
      )
    }

    // Check store pricing mode: if range_rules is active and gaps exist without fallback, block save
    const storeRes = await db.query(
      'SELECT pricing_mode, fallback_markup_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeRes.rows[0]
    if (store.pricing_mode === 'range_rules') {
      if (sanitizedRules.length === 0) {
        return NextResponse.json(
          { error: 'Cannot save 0 rules while store is in active range_rules mode.' },
          { status: 400 }
        )
      }
      if (validation.hasGaps && store.fallback_markup_percent === null) {
        return NextResponse.json(
          {
            error: 'Cannot save range rules with gaps while store is in active range_rules mode without a fallback markup % configured.',
            details: validation.gaps.map((g) => `Gap: £${g.from} to £${g.to}`),
          },
          { status: 400 }
        )
      }
    }

    // 2. Atomic Database Transaction
    client = await db.pool.connect()
    await client.query('BEGIN')

    await client.query('DELETE FROM store_pricing_rules WHERE store_id = $1', [storeId])

    const sorted = sortPricingRules(sanitizedRules)
    const insertedRules = []

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]
      const insertRes = await client.query(
        `INSERT INTO store_pricing_rules (store_id, min_cost, max_cost, markup_percent, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, store_id, min_cost, max_cost, markup_percent, sort_order, active, created_at, updated_at`,
        [storeId, r.min_cost, r.max_cost, r.markup_percent, i, r.active]
      )
      insertedRules.push({
        id: insertRes.rows[0].id,
        store_id: insertRes.rows[0].store_id,
        min_cost: Number(insertRes.rows[0].min_cost),
        max_cost: insertRes.rows[0].max_cost !== null ? Number(insertRes.rows[0].max_cost) : null,
        markup_percent: Number(insertRes.rows[0].markup_percent),
        sort_order: insertRes.rows[0].sort_order,
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
    console.error('Error in bulk saving pricing rules:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  } finally {
    if (client) {
      client.release()
    }
  }
}

/**
 * POST /api/stores/[id]/pricing-rules (Create Single Rule)
 */
export async function POST(request, { params }) {
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

    const storeRes = await db.query(
      'SELECT pricing_mode, fallback_markup_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }
    const store = storeRes.rows[0]

    const body = await request.json().catch(() => ({}))
    const minCost = toNumber(body.min_cost)
    const maxCost = body.max_cost !== null && body.max_cost !== undefined && body.max_cost !== '' ? toNumber(body.max_cost) : null
    const markupPercent = toNumber(body.markup_percent)

    if (minCost === null || minCost < 0) {
      return NextResponse.json({ error: 'Minimum cost must be a non-negative number.' }, { status: 400 })
    }
    if (markupPercent === null || markupPercent < 0) {
      return NextResponse.json({ error: 'Markup percent must be a non-negative number.' }, { status: 400 })
    }
    if (maxCost !== null && maxCost <= minCost) {
      return NextResponse.json({ error: 'Maximum cost must be greater than minimum cost.' }, { status: 400 })
    }

    // Load existing rules and validate combined set
    const existing = await db.query(
      'SELECT id, min_cost, max_cost, markup_percent, active FROM store_pricing_rules WHERE store_id = $1',
      [storeId]
    )

    const combined = [
      ...existing.rows,
      { min_cost: minCost, max_cost: maxCost, markup_percent: markupPercent, active: true },
    ]

    const validation = validatePricingRules(combined, {
      fallbackMarkup: store.fallback_markup_percent,
      requireContinuous: store.pricing_mode === 'range_rules',
    })
    if (!validation.valid) {
      return NextResponse.json({ error: 'Cannot add rule: range conflict detected', details: validation.errors }, { status: 400 })
    }

    const insertRes = await db.query(
      `INSERT INTO store_pricing_rules (store_id, min_cost, max_cost, markup_percent, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, store_id, min_cost, max_cost, markup_percent, sort_order, active, created_at, updated_at`,
      [storeId, minCost, maxCost, markupPercent, existing.rows.length]
    )

    const created = insertRes.rows[0]
    return NextResponse.json({
      rule: {
        id: created.id,
        store_id: created.store_id,
        min_cost: Number(created.min_cost),
        max_cost: created.max_cost !== null ? Number(created.max_cost) : null,
        markup_percent: Number(created.markup_percent),
        sort_order: created.sort_order,
        active: created.active,
        created_at: created.created_at,
        updated_at: created.updated_at,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Error creating single pricing rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}