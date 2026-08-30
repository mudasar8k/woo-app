import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import VendorForm from '../../../components/super-admin/VendorForm'

export default async function EditVendorPage({ params }) {
  await requireSuperAdmin()
  const { id } = await params

  const result = await db.query(
    'SELECT id, name, email, contact_info, status FROM vendors WHERE id = $1',
    [id]
  )

  if (result.rows.length === 0) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Vendor not found</h1>
        <a href="/super-admin/vendors" className="text-indigo-600 hover:text-indigo-800">
          Back to Vendors
        </a>
      </div>
    )
  }

  const vendor = result.rows[0]

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Edit Vendor</h1>
      <VendorForm vendor={vendor} />
    </div>
  )
}


