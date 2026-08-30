import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import SyncManagement from '../../../../components/sync-management'

export default async function SyncPage({ params }) {
  const session = await requireAdmin()
  const { id } = await params
  const storeId = parseInt(id)

  if (session.user.role === 'super_admin') {
    redirect('/super-admin/stores')
  }

  // Check if admin has access to this store
  if (session.user.role !== 'super_admin') {
    const accessCheck = await db.query(
      'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
      [session.user.id, storeId]
    )

    if (accessCheck.rows.length === 0) {
      redirect('/unauthorized')
    }
  }

  // Get store info
  const storeResult = await db.query(
    'SELECT id, name, store_url, status, last_sync_at, connection_method FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get recent sync logs
  const logsResult = await db.query(
    `SELECT id, sync_type, status, items_processed, items_succeeded, items_failed, 
            error_message, started_at, completed_at
     FROM sync_logs 
     WHERE store_id = $1
     ORDER BY started_at DESC
     LIMIT 10`,
    [storeId]
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Sync Management</h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
      </div>
      <SyncManagement
        store={store}
        syncLogs={logsResult.rows}
      />
    </div>
  )
}
