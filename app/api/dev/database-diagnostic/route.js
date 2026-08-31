export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '../../../../lib/db'
import { auth } from '../../../auth/[...nextauth]/route'
import { requireAdminOrSuperAdminApi } from '../../../../lib/role-guards'

export async function GET() {
  try {
    const session = await auth()
    const roleCheck = requireAdminOrSuperAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    // 1. Current DB & Server identity (safe metadata only)
    const dbInfoRes = await db.query(
      `SELECT current_database() as db_name,
              current_user as db_user,
              inet_server_addr() as server_addr,
              version() as pg_version`
    )

    // 2. Safe host fingerprint from process.env.DATABASE_URL
    const dbUrl = process.env.DATABASE_URL || ''
    let safeHostPrefix = 'unset'
    let isPooled = false
    let endpointId = 'unknown'
    try {
      const match = dbUrl.match(/@([^:\/]+)/)
      if (match) {
        const host = match[1]
        isPooled = host.includes('-pooler.')
        const parts = host.split('.')
        endpointId = parts[0] || 'unknown'
        safeHostPrefix = host.slice(0, 14) + '...'
      }
    } catch {
      safeHostPrefix = 'error'
    }

    // 3. Store 4 config
    const store4Res = await db.query(
      `SELECT id, name, pricing_mode, price_rule_percent, fallback_markup_percent
       FROM stores
       WHERE id = 4`
    )

    // 4. Store 4 pricing rules in database
    const rulesRes = await db.query(
      `SELECT id, store_id, min_cost, max_cost, markup_percent, sort_order, active
       FROM store_pricing_rules
       WHERE store_id = 4
       ORDER BY sort_order ASC, id ASC`
    )

    // 5. Store 4 category pricing rules in database
    const catRulesRes = await db.query(
      `SELECT id, store_id, category, markup_percent, priority, active
       FROM store_category_pricing_rules
       WHERE store_id = 4
       ORDER BY priority ASC, id ASC`
    )

    return NextResponse.json(
      {
        deployed_commit: process.env.VERCEL_GIT_COMMIT_SHA || 'a6f277e04939fb57d4952a039eded47f32178b8d',
        vercel_env: process.env.VERCEL_ENV || 'unknown',
        database_info: {
          database_name: dbInfoRes.rows[0]?.db_name,
          db_user_prefix: (dbInfoRes.rows[0]?.db_user || '').slice(0, 6) + '...',
          endpoint_prefix: endpointId.slice(0, 12) + '...',
          is_pooled: isPooled,
          server_addr: dbInfoRes.rows[0]?.server_addr ? String(dbInfoRes.rows[0].server_addr) : 'cloud',
        },
        store_4: {
          config: store4Res.rows[0] || null,
          pricing_rules_count: rulesRes.rows.length,
          pricing_rules: rulesRes.rows.map((r) => ({
            id: r.id,
            min_cost: Number(r.min_cost),
            max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
            markup_percent: Number(r.markup_percent),
            sort_order: r.sort_order,
            active: r.active,
          })),
          category_rules_count: catRulesRes.rows.length,
          category_rules: catRulesRes.rows.map((r) => ({
            id: r.id,
            category: r.category,
            markup_percent: Number(r.markup_percent),
            priority: r.priority,
            active: r.active,
          })),
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    )
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
