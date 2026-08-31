export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextResponse } from 'next/server'
import db from '@/app/lib/db'
import { auth } from '@/app/api/auth/[...nextauth]/route'
import { requireAdminOrSuperAdminApi } from '@/app/lib/role-guards'

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

    // 3. Store 4 config & column check
    let store4 = null
    let pricingModeColumnExists = false
    try {
      const colCheck = await db.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'stores'
           AND column_name = 'pricing_mode'`
      )
      pricingModeColumnExists = colCheck.rows.length > 0
    } catch {
      pricingModeColumnExists = false
    }

    try {
      if (pricingModeColumnExists) {
        const store4Res = await db.query(
          `SELECT id, name, pricing_mode, price_rule_percent, fallback_markup_percent
           FROM stores
           WHERE id = 4`
        )
        store4 = store4Res.rows[0] || null
      } else {
        const store4Res = await db.query(
          `SELECT id, name, price_rule_percent
           FROM stores
           WHERE id = 4`
        )
        store4 = store4Res.rows[0] || null
      }
    } catch {
      store4 = null
    }

    // 4. Check tables existence
    let storePricingRulesTableExists = false
    let productStorePricingTableExists = false
    let storeCategoryPricingRulesTableExists = false
    try {
      const t1 = await db.query(`SELECT to_regclass('public.store_pricing_rules') as reg`)
      storePricingRulesTableExists = t1.rows[0]?.reg !== null
    } catch {}

    try {
      const t2 = await db.query(`SELECT to_regclass('public.product_store_pricing') as reg`)
      productStorePricingTableExists = t2.rows[0]?.reg !== null
    } catch {}

    try {
      const t3 = await db.query(`SELECT to_regclass('public.store_category_pricing_rules') as reg`)
      storeCategoryPricingRulesTableExists = t3.rows[0]?.reg !== null
    } catch {}

    // 5. Store 4 pricing rules count
    let rules = []
    if (storePricingRulesTableExists) {
      try {
        const rulesRes = await db.query(
          `SELECT id, store_id, min_cost, max_cost, markup_percent, sort_order, active
           FROM store_pricing_rules
           WHERE store_id = 4
           ORDER BY sort_order ASC, id ASC`
        )
        rules = rulesRes.rows.map((r) => ({
          id: r.id,
          min_cost: Number(r.min_cost),
          max_cost: r.max_cost !== null ? Number(r.max_cost) : null,
          markup_percent: Number(r.markup_percent),
          sort_order: r.sort_order,
          active: r.active,
        }))
      } catch {}
    }

    return NextResponse.json(
      {
        deployed_commit: process.env.VERCEL_GIT_COMMIT_SHA || 'dev-head',
        vercel_env: process.env.VERCEL_ENV || 'unknown',
        database_info: {
          database_name: dbInfoRes.rows[0]?.db_name,
          db_user_prefix: (dbInfoRes.rows[0]?.db_user || '').slice(0, 6) + '...',
          endpoint_prefix: endpointId.slice(0, 12) + '...',
          is_pooled: isPooled,
          server_addr: dbInfoRes.rows[0]?.server_addr ? String(dbInfoRes.rows[0].server_addr) : 'cloud',
        },
        schema_status: {
          stores_has_pricing_mode: pricingModeColumnExists,
          has_store_pricing_rules: storePricingRulesTableExists,
          has_product_store_pricing: productStorePricingTableExists,
          has_store_category_pricing_rules: storeCategoryPricingRulesTableExists,
        },
        store_4: {
          config: store4,
          pricing_rules_count: rules.length,
          pricing_rules: rules,
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
