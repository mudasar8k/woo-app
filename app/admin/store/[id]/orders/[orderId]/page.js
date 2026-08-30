import { requireAdmin } from '../../../../../lib/auth'
import db from '../../../../../lib/db'
import { redirect, notFound } from 'next/navigation'
import { formatDateTime } from '../../../../../lib/format-date'
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

function parseAddress(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return { raw: String(value) }
  }
}

function parseLineItems(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return [value]
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function AddressBlock({ title, address }) {
  if (!address) {
    return (
      <div>
        <h3 className="text-sm font-medium text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-500">—</p>
      </div>
    )
  }

  if (address.raw) {
    return (
      <div>
        <h3 className="text-sm font-medium text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-700 whitespace-pre-wrap">{address.raw}</p>
      </div>
    )
  }

  const lines = [
    [address.first_name, address.last_name].filter(Boolean).join(' '),
    address.company,
    address.address_1,
    address.address_2,
    [address.city, address.state, address.postcode].filter(Boolean).join(', '),
    address.country,
    address.email,
    address.phone,
  ].filter(Boolean)

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 mb-2">{title}</h3>
      <div className="text-sm text-gray-700 space-y-0.5">
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  )
}

export default async function OrderDetailPage({ params }) {
  const session = await requireAdmin()
  const { id, orderId } = await params
  const storeId = parseInt(id, 10)
  const localOrderId = parseInt(orderId, 10)
  const isStoreAdmin = session.user.role === 'admin'

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

  const orderResult = await db.query(
    `SELECT * FROM orders WHERE id = $1 AND store_id = $2 LIMIT 1`,
    [localOrderId, storeId]
  )
  if (orderResult.rows.length === 0) {
    notFound()
  }

  const order = orderResult.rows[0]
  const lineItems = parseLineItems(order.line_items)
  const billing = parseAddress(order.billing_address)
  const shipping = parseAddress(order.shipping_address)

  return (
    <div>
      <div className="mb-6">
        <p className="text-sm text-gray-500 mb-1">
          <Link href={`/admin/store/${storeId}`} className="text-indigo-600 hover:text-indigo-800">
            {store.name}
          </Link>
          <span className="mx-2">/</span>
          <Link
            href={`/admin/store/${storeId}/orders`}
            className="text-indigo-600 hover:text-indigo-800"
          >
            Orders
          </Link>
          <span className="mx-2">/</span>
          #{order.order_number || order.woo_order_id}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold text-gray-900">
            Order #{order.order_number || order.woo_order_id}
          </h1>
          <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            {order.status}
          </span>
        </div>
        <p className="text-gray-600 mt-1">
          WooCommerce #{order.woo_order_id} · {formatDateTime(order.created_at)}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="bg-white shadow rounded-lg p-5 lg:col-span-2">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Line items</h2>
          {lineItems.length === 0 ? (
            <p className="text-sm text-gray-500">No line items.</p>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500 uppercase">
                  <th className="pb-2">Item</th>
                  <th className="pb-2">SKU</th>
                  <th className="pb-2">Qty</th>
                  <th className="pb-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lineItems.map((item, idx) => (
                  <tr key={item.id || idx} className="text-sm">
                    <td className="py-2 pr-2 text-gray-900">{item.name || '—'}</td>
                    <td className="py-2 pr-2 text-gray-500">{item.sku || '—'}</td>
                    <td className="py-2 pr-2 text-gray-700">{item.quantity ?? '—'}</td>
                    <td className="py-2 text-right text-gray-900">
                      {formatMoney(item.total, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white shadow rounded-lg p-5 space-y-4">
          <h2 className="text-lg font-medium text-gray-900">Summary</h2>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between">
              <dt className="text-gray-500">Subtotal</dt>
              <dd>{formatMoney(order.subtotal, order.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Shipping</dt>
              <dd>{formatMoney(order.shipping_total, order.currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Tax</dt>
              <dd>{formatMoney(order.tax_total, order.currency)}</dd>
            </div>
            <div className="flex justify-between font-medium text-gray-900 border-t pt-2">
              <dt>Total</dt>
              <dd>{formatMoney(order.total, order.currency)}</dd>
            </div>
          </dl>
          <div className="border-t pt-3 text-sm">
            <p className="text-gray-500">Payment</p>
            <p className="text-gray-900">
              {order.payment_method_title || order.payment_method || '—'}
            </p>
          </div>
          <div className="text-sm">
            <p className="text-gray-500">Last synced</p>
            <p className="text-gray-900">{formatDateTime(order.synced_at)}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white shadow rounded-lg p-5">
          <AddressBlock title="Billing" address={billing} />
          {order.customer_email && (
            <p className="mt-3 text-sm text-gray-600">{order.customer_email}</p>
          )}
        </div>
        <div className="bg-white shadow rounded-lg p-5">
          <AddressBlock title="Shipping" address={shipping} />
        </div>
      </div>
    </div>
  )
}
