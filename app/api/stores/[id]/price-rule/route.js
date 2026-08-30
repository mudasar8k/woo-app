import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import {
  requireAdminOrSuperAdminApi,
  verifyAdminStoreAccess,
} from '../../../../lib/role-guards'
import { getStorePricingContext } from '../../../../lib/app-settings'
import { parsePriceRuleInput } from '../../../../lib/pricing'

/**
 * GET /api/stores/[id]/price-rule — effective + override + default for a store.
 * PUT /api/stores/[id]/price-rule — set/clear store override (assigned admin or super admin).
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

    const storeResult = await db.query(
      'SELECT id, name, price_rule_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeResult.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeResult.rows[0]
    const pricing = await getStorePricingContext(store)

    return NextResponse.json({
      store_id: store.id,
      store_name: store.name,
      price_rule_percent: pricing.override,
      default_price_rule_percent: pricing.defaultPercent,
      effective_price_rule_percent: pricing.effective,
      is_override: pricing.isOverride,
    })
  } catch (error) {
    console.error('Error loading store price rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

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
    let percent
    try {
      percent = parsePriceRuleInput(body.price_rule_percent)
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }

    const result = await db.query(
      `UPDATE stores
       SET price_rule_percent = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, name, price_rule_percent`,
      [percent, storeId]
    )

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = result.rows[0]
    const pricing = await getStorePricingContext(store)

    return NextResponse.json({
      store_id: store.id,
      store_name: store.name,
      price_rule_percent: pricing.override,
      default_price_rule_percent: pricing.defaultPercent,
      effective_price_rule_percent: pricing.effective,
      is_override: pricing.isOverride,
    })
  } catch (error) {
    console.error('Error saving store price rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
