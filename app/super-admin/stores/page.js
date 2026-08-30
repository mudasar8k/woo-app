import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import StoresList from '../../components/super-admin/StoresList'

export default async function StoresPage() {
  await requireSuperAdmin()

  const result = await db.query(
    'SELECT id, name, store_url, status, connection_method, last_sync_at, created_at FROM stores ORDER BY created_at DESC'
  )

  return (
    <div className="space-y-6">
      <StoresList stores={result.rows} />
    </div>
  )
}


