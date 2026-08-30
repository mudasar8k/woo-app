import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { redirect } from 'next/navigation'
import { VENDOR_STORE_JOIN } from '../../../lib/vendor-store-filter'
import RalawiseSyncButton from '../../../components/ralawise-sync-button'

export default async function StoreDashboardPage({ params }) {
  const session = await requireAdmin()
  const { id } = await params
  const storeId = parseInt(id)
  const isStoreAdmin = session.user.role === 'admin'

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
    'SELECT id, name, store_url, status FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Store not found</h1>
        <a href="/dashboard" className="text-indigo-600 hover:text-indigo-800">
          Back to Dashboard
        </a>
      </div>
    )
  }

  const store = storeResult.rows[0]

  const [productsResult, ordersResult, csvUploadsResult, vendorsResult] =
    await Promise.all([
      db.query(
        `SELECT COUNT(*) as count
         FROM products p
         LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
         ${VENDOR_STORE_JOIN}
         WHERE p.status = 'approved' AND (ps.status IS NULL OR ps.status != 'removed')`,
        [storeId]
      ),
      db.query('SELECT COUNT(*) as count FROM orders WHERE store_id = $1', [
        storeId,
      ]),
      db.query(
        'SELECT COUNT(*) as count FROM csv_uploads WHERE store_id = $1',
        [storeId]
      ),
      db.query(
        `SELECT id, name FROM vendors WHERE status = 'active' ORDER BY name ASC`
      ),
    ])

  const stats = {
    products: parseInt(productsResult.rows[0].count),
    orders: parseInt(ordersResult.rows[0].count),
    csvUploads: parseInt(csvUploadsResult.rows[0].count),
  }

  const vendors = vendorsResult.rows
  const defaultVendorId =
    process.env.RALAWISE_DEFAULT_VENDOR_ID ||
    (vendors.find((v) => v.name.toLowerCase() === 'ralawise')?.id ??
      vendors[0]?.id ??
      '')

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">{store.name}</h1>
        <p className="text-gray-600 mt-1">{store.store_url}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">Products</h3>
          <p className="text-3xl font-bold text-indigo-600">{stats.products}</p>
          <p className="text-sm text-gray-500 mt-1">Approved and ready to sync</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">Orders</h3>
          <p className="text-3xl font-bold text-green-600">{stats.orders}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-700 mb-2">CSV Uploads</h3>
          <p className="text-3xl font-bold text-blue-600">{stats.csvUploads}</p>
        </div>
      </div>

      <div className="mb-6 bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-medium text-gray-900 mb-1">Sync from Ralawise</h3>
        <p className="text-sm text-gray-600 mb-4">
          Download the latest Ralawise WordPress CSVs and import new + updated products
          into WooApp for this store.
        </p>
        <RalawiseSyncButton
          storeId={storeId}
          vendors={vendors}
          defaultVendorId={String(defaultVendorId || '')}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {!isStoreAdmin && (
          <>
            <a
              href={`/admin/store/${storeId}/import?type=products`}
              className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
            >
              <h3 className="text-lg font-medium text-gray-900 mb-2">Upload Products</h3>
              <p className="text-gray-600 text-sm">Import parent product rows from CSV</p>
            </a>
            <a
              href={`/admin/store/${storeId}/import?type=variations`}
              className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
            >
              <h3 className="text-lg font-medium text-gray-900 mb-2">Upload Variations</h3>
              <p className="text-gray-600 text-sm">Import variant rows linked by parent SKU</p>
            </a>
          </>
        )}
        <a
          href={`/admin/store/${storeId}/products`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {isStoreAdmin ? 'Products' : 'Review Products'}
          </h3>
          <p className="text-gray-600 text-sm">
            {isStoreAdmin
              ? 'View products assigned to this store'
              : 'Review and approve pending products'}
          </p>
        </a>
        <a
          href={`/admin/store/${storeId}/sync`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Sync</h3>
          <p className="text-gray-600 text-sm">Sync products with WooCommerce</p>
        </a>
        <a
          href={`/admin/store/${storeId}/orders`}
          className="bg-white p-6 rounded-lg shadow hover:shadow-lg transition-shadow"
        >
          <h3 className="text-lg font-medium text-gray-900 mb-2">Orders</h3>
          <p className="text-gray-600 text-sm">View and manage orders</p>
        </a>
      </div>
    </div>
  )
}
