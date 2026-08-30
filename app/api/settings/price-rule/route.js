import { NextResponse } from 'next/server'
import { auth } from '../../auth/[...nextauth]/route'
import { requireSuperAdminApi } from '../../../lib/role-guards'
import {
  getDefaultPriceRulePercent,
  setDefaultPriceRulePercent,
} from '../../../lib/app-settings'
import { parsePriceRuleInput } from '../../../lib/pricing'

/**
 * GET /api/settings/price-rule — global default markup (any authenticated admin).
 * PUT /api/settings/price-rule — set default (super admin only).
 */
export async function GET() {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const default_price_rule_percent = await getDefaultPriceRulePercent()
    return NextResponse.json({ default_price_rule_percent })
  } catch (error) {
    console.error('Error loading default price rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(request) {
  try {
    const session = await auth()
    const roleCheck = requireSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json().catch(() => ({}))
    let percent
    try {
      percent = parsePriceRuleInput(body.default_price_rule_percent)
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }

    await setDefaultPriceRulePercent(percent)
    return NextResponse.json({ default_price_rule_percent: percent })
  } catch (error) {
    console.error('Error saving default price rule:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
