import { requireSuperAdmin } from '../../../lib/auth'
import VendorForm from '../../../components/super-admin/VendorForm'

export default async function NewVendorPage() {
  await requireSuperAdmin()

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Add New Vendor</h1>
      <VendorForm />
    </div>
  )
}






