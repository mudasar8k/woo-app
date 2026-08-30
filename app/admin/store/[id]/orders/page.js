import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import { formatDateTime } from '../../../../lib/format-date'
import Link from 'next/link'

function formatMoney(amount, currency = 'USD') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

function statusClass(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'completed' || s === 'processing') return 'bg-green-100 text-green-800'
  if (s === 'pending' || s === 'on-hold') return 'bg-yellow-100 text-yellow-800'
  if (s === 'cancelled' || s === 'failed' || s === 'refunded') return 'bg-red-100 text-red-800'
  return 'bg-gray-100 text-gray-800'
}

export default async function OrdersPage({ params, searchParams }) {
  const session = await requireAdmin()
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const storeId = parseInt(id, 10)
  const isStoreAdmin = session.user.role === 'admin'
  const status = resolvedSearchParams?.status || 'all'
  const page = parseInt(resolvedSearchParams?.page || '1', 10)
  const limit = parseInt(resolvedSearchParams?.limit || '25', 10)
  const offset = (page - 1) * limit

  if (isStoreAdmin) {
    const accessCheck = await db.query(
      'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
      [session.user.id, storeId]
    )
    if (accessCheck.rows.length === 0) {
      redirect('/unauthorized')
    }
  }

  const storeResult = await db.query(
    'SELECT id, name FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  const filterParams = [storeId]
  let where = 'WHERE store_id = $1'
  let nextIndex = 2

  if (status !== 'all') {
    where += ` AND status = $${nextIndex}`
    filterParams.push(status)
    nextIndex += 1
  }

  const countResult = await db.query(
    `SELECT COUNT(*) AS count FROM orders ${where}`,
    filterParams
  )
  const total = parseInt(countResult.rows[0].count, 10)
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const listParams = [...filterParams, limit, offset]
  const ordersResult = await db.query(
    `SELECT id, woo_order_id, order_number, status, currency, total,
            customer_email, customer_name, created_at, synced_at
     FROM orders
     ${where}
     ORDER BY created_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    listParams
  )

  const orders = ordersResult.rows
  const statuses = [
    'all',
    'pending',
    'processing',
    'on-hold',
    'completed',
    'cancelled',
    'refunded',
    'failed',
  ]

  function buildHref(overrides = {}) {
    const q = new URLSearchParams()
    const nextStatus = overrides.status ?? status
    const nextPage = overrides.page ?? page
    if (nextStatus && nextStatus !== 'all') q.set('status', nextStatus)
    if (nextPage > 1) q.set('page', String(nextPage))
    const qs = q.toString()
    return `/admin/store/${storeId}/orders${qs ? `?${qs}` : ''}`
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm text-gray-500 mb-1">
            <Link href={`/admin/store/${storeId}`} className="text-indigo-600 hover:text-indigo-800">
              {store.name}
            </Link>
            <span className="mx-2">/</span>
            Orders
          </p>
          <h1 className="text-3xl font-bold text-gray-900">Orders</h1>
          <p className="text-gray-600 mt-1">
            Synced from WooCommerce via the WooApp Connector plugin ({total} total)
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {statuses.map((s) => (
          <Link
            key={s}
            href={buildHref({ status: s, page: 1 })}
            className={`px-3 py-1.5 text-sm rounded-md border ${
              status === s
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {s === 'all' ? 'All' : s}
          </Link>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        {orders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="mb-2">No orders found for this store.</p>
            <p className="text-sm">
              In WordPress, open WooApp Connector and use &quot;Push Orders to WooApp&quot; to
              backfill, or place a new order to sync automatically.
            </p>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Order
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Customer
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Total
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <Link
                      href={`/admin/store/${storeId}/orders/${order.id}`}
                      className="font-medium text-indigo-600 hover:text-indigo-800"
                    >
                      #{order.order_number || order.woo_order_id}
                    </Link>
                    <div className="text-xs text-gray-400">WC #{order.woo_order_id}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    <div>{order.customer_name || '—'}</div>
                    <div className="text-xs text-gray-500">{order.customer_email || ''}</div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusClass(
                        order.status
                      )}`}
                    >
                      {order.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                    {formatMoney(order.total, order.currency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {formatDateTime(order.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Link
              href={buildHref({ page: Math.max(1, page - 1) })}
              className={`px-3 py-2 text-sm border rounded-md ${
                page <= 1
                  ? 'pointer-events-none opacity-40 border-gray-200'
                  : 'border-gray-300 hover:bg-gray-50'
              }`}
            >
              Previous
            </Link>
            <Link
              href={buildHref({ page: Math.min(totalPages, page + 1) })}
              className={`px-3 py-2 text-sm border rounded-md ${
                page >= totalPages
                  ? 'pointer-events-none opacity-40 border-gray-200'
                  : 'border-gray-300 hover:bg-gray-50'
              }`}
            >
              Next
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
