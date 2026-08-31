export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '@/app/lib/db'
import { auth } from '@/app/api/auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '@/app/lib/role-guards'
import { getStorePricingContext } from '@/app/lib/app-settings'
import { validatePricingRules, toNumber } from '@/app/lib/pricing'

/**
 * GET /api/stores/[id]/pricing-config
 * Returns current store pricing configuration (mode, fallback markup, legacy override, effective markup).
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

    const storeRes = await db.query(
      `SELECT id, name, pricing_mode, price_rule_percent, fallback_markup_percent
       FROM stores
       WHERE id = $1`,
      [storeId]
    )

    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeRes.rows[0]
    const pricing = await getStorePricingContext(store)

    return NextResponse.json(
      {
        store_id: store.id,
        store_name: store.name,
        pricing_mode: store.pricing_mode || 'legacy_markup',
        price_rule_percent: store.price_rule_percent !== null ? Number(store.price_rule_percent) : null,
        fallback_markup_percent:
          store.fallback_markup_percent !== null ? Number(store.fallback_markup_percent) : null,
        is_override: pricing.isOverride,
        effective_price_rule_percent: pricing.effective,
        global_default_percent: pricing.defaultPercent,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    )
  } catch (error) {
    console.error('Error fetching store pricing config:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PUT /api/stores/[id]/pricing-config
 * Updates store pricing configuration (mode, fallback markup, legacy override).
 *
 * Payload examples:
 * 1. Tiered Activation: { "pricing_mode": "range_rules", "fallback_markup_percent": null }
 * 2. Legacy Reversion:  { "pricing_mode": "legacy_markup", "price_rule_percent": 177, "fallback_markup_percent": null }
 */
export async function PUT(request, { params }) {
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

    const storeRes = await db.query(
      `SELECT id, name, pricing_mode, price_rule_percent, fallback_markup_percent
       FROM stores
       WHERE id = $1`,
      [storeId]
    )

    if (storeRes.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const currentStore = storeRes.rows[0]
    const targetMode = body.pricing_mode || currentStore.pricing_mode || 'legacy_markup'

    if (!['legacy_markup', 'range_rules'].includes(targetMode)) {
      return NextResponse.json(
        { error: 'Invalid pricing_mode. Must be "legacy_markup" or "range_rules".' },
        { status: 400 }
      )
    }

    const parsedFallback =
      body.fallback_markup_percent !== undefined
        ? toNumber(body.fallback_markup_percent)
        : currentStore.fallback_markup_percent !== null
        ? Number(currentStore.fallback_markup_percent)
        : null

    let parsedLegacyOverride =
      body.price_rule_percent !== undefined
        ? toNumber(body.price_rule_percent)
        : currentStore.price_rule_percent !== null
        ? Number(currentStore.price_rule_percent)
        : null

    // ── Active-Mode Safety Validation when switching to / activating range_rules ───
    if (targetMode === 'range_rules') {
      const rulesRes = await db.query(
        `SELECT id, min_cost, max_cost, markup_percent, active
         FROM store_pricing_rules
         WHERE store_id = $1
         ORDER BY min_cost ASC, sort_order ASC`,
        [storeId]
      )

      const activeRules = rulesRes.rows.filter((r) => r.active !== false)

      if (activeRules.length === 0) {
        return NextResponse.json(
          { error: 'Cannot activate tiered pricing: no active price range rules exist for this store.' },
          { status: 400 }
        )
      }

      const validation = validatePricingRules(activeRules, {
        fallbackMarkup: parsedFallback,
        requireContinuous: true,
      })

      if (!validation.valid) {
        return NextResponse.json(
          {
            error: 'Cannot activate tiered pricing: pricing rules validation failed.',
            details: validation.errors,
          },
          { status: 400 }
        )
      }
    }

    // ── Update stores table atomically ──────────────────────────────────────────
    const updateRes = await db.query(
      `UPDATE stores
       SET pricing_mode = $1,
           price_rule_percent = $2,
           fallback_markup_percent = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, name, pricing_mode, price_rule_percent, fallback_markup_percent`,
      [targetMode, parsedLegacyOverride, parsedFallback, storeId]
    )

    const updatedStore = updateRes.rows[0]
    const pricing = await getStorePricingContext(updatedStore)

    return NextResponse.json({
      success: true,
      store_id: updatedStore.id,
      store_name: updatedStore.name,
      pricing_mode: updatedStore.pricing_mode,
      price_rule_percent:
        updatedStore.price_rule_percent !== null ? Number(updatedStore.price_rule_percent) : null,
      fallback_markup_percent:
        updatedStore.fallback_markup_percent !== null
          ? Number(updatedStore.fallback_markup_percent)
          : null,
      is_override: pricing.isOverride,
      effective_price_rule_percent: pricing.effective,
      global_default_percent: pricing.defaultPercent,
    })
  } catch (error) {
    console.error('Error updating store pricing config:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
