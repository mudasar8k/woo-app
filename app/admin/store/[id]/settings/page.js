import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import { getStorePricingContext } from '../../../../lib/app-settings'
import StorePriceRuleSettings from '../../../../components/StorePriceRuleSettings'

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

  const storeResult = await db.query(
    'SELECT id, name, price_rule_percent FROM stores WHERE id = $1',
    [storeId]
  )
  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]
  const pricing = await getStorePricingContext(store)

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
      />
    </div>
  )
}
