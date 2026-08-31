import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import { getStorePricingContext } from '../../../../lib/app-settings'
import StorePriceRuleSettings from '../../../../components/StorePriceRuleSettings'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function StoreSettingsPage({ params }) {
  const session = await requireAdmin()
  const { id } = await params
  const storeId = parseInt(id, 10)

  if (session.user.role === 'super_admin') {
    redirect(`/super-admin/stores/${storeId}`)
  }

  const accessCheck = await db.query(
    'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
    [session.user.id, storeId]
  )
  if (accessCheck.rows.length === 0) {
    redirect('/unauthorized')
  }

  let store = null
  try {
    const storeResult = await db.query(
      'SELECT id, name, price_rule_percent, pricing_mode, fallback_markup_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeResult.rows.length > 0) {
      store = storeResult.rows[0]
    }
  } catch {
    const storeResult = await db.query(
      'SELECT id, name, price_rule_percent FROM stores WHERE id = $1',
      [storeId]
    )
    if (storeResult.rows.length > 0) {
      store = storeResult.rows[0]
    }
  }

  if (!store) {
    redirect('/dashboard')
  }

  const pricing = await getStorePricingContext(store)

  // Fetch initial draft/active range pricing rules
  let initialRules = []
  try {
    const rulesRes = await db.query(
      `SELECT id, store_id, min_cost, max_cost, markup_percent, sort_order, active, created_at, updated_at
       FROM store_pricing_rules
       WHERE store_id = $1
       ORDER BY min_cost ASC, sort_order ASC`,
      [storeId]
    )
    initialRules = rulesRes.rows.map((r) => ({
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
    initialRules = []
  }

  // Fetch initial category pricing rules
  let initialCatRules = []
  try {
    const catRes = await db.query(
      `SELECT id, store_id, category, markup_percent, priority, active, created_at, updated_at
       FROM store_category_pricing_rules
       WHERE store_id = $1
       ORDER BY priority ASC, id ASC`,
      [storeId]
    )
    initialCatRules = catRes.rows.map((r) => ({
      id: r.id,
      store_id: r.store_id,
      category: r.category,
      markup_percent: Number(r.markup_percent),
      priority: Number(r.priority),
      active: r.active,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
  } catch {
    initialCatRules = []
  }

  // Fetch available distinct categories from product catalog
  let availableCategories = []
  try {
    const catTokensRes = await db.query(
      `SELECT DISTINCT categories FROM products WHERE categories IS NOT NULL AND categories != ''`
    )
    const set = new Set()
    for (const row of catTokensRes.rows) {
      const tokens = String(row.categories).split(',').map((t) => t.trim()).filter(Boolean)
      for (const t of tokens) set.add(t)
    }
    availableCategories = Array.from(set).sort()
  } catch {
    availableCategories = []
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
      </div>
      <StorePriceRuleSettings
        storeId={store.id}
        storeName={store.name}
        initialOverride={pricing.override}
        defaultPercent={pricing.defaultPercent}
        initialEffective={pricing.effective}
        initialIsOverride={pricing.isOverride}
        initialPricingMode={store.pricing_mode || 'legacy_markup'}
        initialFallbackMarkup={store.fallback_markup_percent !== null && store.fallback_markup_percent !== undefined ? Number(store.fallback_markup_percent) : null}
        initialRules={initialRules}
        initialCatRules={initialCatRules}
        initialAvailableCategories={availableCategories}
      />
    </div>
  )
}
