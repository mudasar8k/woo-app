import { requireSuperAdmin } from '../../lib/auth'
import { getDefaultPriceRulePercent } from '../../lib/app-settings'
import DefaultPriceRuleForm from '../../components/super-admin/DefaultPriceRuleForm'

export default async function SuperAdminSettingsPage() {
  await requireSuperAdmin()
  const defaultPercent = await getDefaultPriceRulePercent()

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600 mt-1">
          Global defaults for all stores. Store admins can override pricing on their Settings page.
        </p>
      </div>
      <DefaultPriceRuleForm initialPercent={defaultPercent} />
    </div>
  )
}
