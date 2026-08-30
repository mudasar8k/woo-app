import { NextResponse } from 'next/server'
import db from '../../../../../lib/db'
import { auth } from '../../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../../lib/role-guards'
import { validatePricingRules, toNumber } from '../../../../../lib/pricing'

/**
 * DELETE /api/stores/[id]/pricing-rules/[ruleId]
 */
export async function DELETE(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id, ruleId: ruleIdParam } = await params
    const storeId = parseInt(id, 10)
    const ruleId = parseInt(ruleIdParam, 10)

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

    // Active mode safety check
    if (store.pricing_mode === 'range_rules') {
      const remainingRes = await db.query(
        'SELECT id, min_cost, max_cost, markup_percent, active FROM store_pricing_rules WHERE store_id = $1 AND id != $2',
        [storeId, ruleId]
      )
      const remaining = remainingRes.rows

      if (remaining.length === 0) {
        return NextResponse.json(
          { error: 'Cannot delete the only pricing rule while store is in active range_rules mode.' },
          { status: 400 }
        )
      }

      const validation = validatePricingRules(remaining, {
        fallbackMarkup: store.fallback_markup_percent,
        requireContinuous: true,
      })

      if (!validation.valid) {
        return NextResponse.json(
          {
            error: 'Cannot delete rule: deletion would leave active store with uncovered pricing gaps without a fallback markup.',
            details: validation.errors,
          },
          { status: 400 }
        )
      }
    }

    const deleteRes = await db.query(
      'DELETE FROM store_pricing_rules WHERE id = $1 AND store_id = $2 RETURNING id',
      [ruleId, storeId]
    )

    if (deleteRes.rows.length === 0) {
      return NextResponse.json({ error: 'Pricing rule not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, deleted_id: ruleId })
  } catch (error) {
    console.error('Error deleting pricing rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/stores/[id]/pricing-rules/[ruleId]
 */
export async function PUT(request, { params }) {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const { id, ruleId: ruleIdParam } = await params
    const storeId = parseInt(id, 10)
    const ruleId = parseInt(ruleIdParam, 10)

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
    const active = body.active !== undefined ? Boolean(body.active) : true

    if (minCost === null || minCost < 0) {
      return NextResponse.json({ error: 'Minimum cost must be a non-negative number.' }, { status: 400 })
    }
    if (markupPercent === null || markupPercent < 0) {
      return NextResponse.json({ error: 'Markup percent must be a non-negative number.' }, { status: 400 })
    }
    if (maxCost !== null && maxCost <= minCost) {
      return NextResponse.json({ error: 'Maximum cost must be greater than minimum cost.' }, { status: 400 })
    }

    // Load other rules for this store
    const existing = await db.query(
      'SELECT id, min_cost, max_cost, markup_percent, active FROM store_pricing_rules WHERE store_id = $1 AND id != $2',
      [storeId, ruleId]
    )

    const proposedRules = [
      ...existing.rows,
      { id: ruleId, min_cost: minCost, max_cost: maxCost, markup_percent: markupPercent, active },
    ]

    const validation = validatePricingRules(proposedRules, {
      fallbackMarkup: store.fallback_markup_percent,
      requireContinuous: store.pricing_mode === 'range_rules',
    })
    if (!validation.valid) {
      return NextResponse.json({ error: 'Rule update conflicts with existing price ranges', details: validation.errors }, { status: 400 })
    }

    const updateRes = await db.query(
      `UPDATE store_pricing_rules
       SET min_cost = $1, max_cost = $2, markup_percent = $3, active = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND store_id = $6
       RETURNING id, store_id, min_cost, max_cost, markup_percent, sort_order, active, created_at, updated_at`,
      [minCost, maxCost, markupPercent, active, ruleId, storeId]
    )

    if (updateRes.rows.length === 0) {
      return NextResponse.json({ error: 'Pricing rule not found' }, { status: 404 })
    }

    const updated = updateRes.rows[0]
    return NextResponse.json({
      rule: {
        id: updated.id,
        store_id: updated.store_id,
        min_cost: Number(updated.min_cost),
        max_cost: updated.max_cost !== null ? Number(updated.max_cost) : null,
        markup_percent: Number(updated.markup_percent),
        sort_order: updated.sort_order,
        active: updated.active,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      },
    })
  } catch (error) {
    console.error('Error updating pricing rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}