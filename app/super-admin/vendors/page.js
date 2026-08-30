import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import VendorsList from '../../components/super-admin/VendorsList'

export default async function VendorsPage() {
  await requireSuperAdmin()

  const result = await db.query(
    'SELECT id, name, email, contact_info, status, created_at FROM vendors ORDER BY created_at DESC'
  )

  return (
    <div className="space-y-6">
      <VendorsList vendors={result.rows} />
    </div>
  )
}
