const db = require('./db')

/**
 * Normalize a single inbound order payload from the WooApp Connector plugin
 * into columns matching the `orders` table.
 *
 * @param {object} raw
 * @returns {{ ok: true, row: object } | { ok: false, error: string }}
 */
function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Order payload must be an object' }
  }

  const wooOrderId = parseInt(raw.woo_order_id ?? raw.id, 10)
  if (!Number.isFinite(wooOrderId) || wooOrderId <= 0) {
    return { ok: false, error: 'Missing or invalid woo_order_id' }
  }

  const status = String(raw.status || '').replace(/^wc-/, '').trim()
  if (!status) {
    return { ok: false, error: `Order ${wooOrderId}: status is required` }
  }

  const total = Number(raw.total)
  if (!Number.isFinite(total)) {
    return { ok: false, error: `Order ${wooOrderId}: total is required` }
  }

  const toMoney = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  const addressToText = (addr) => {
    if (addr == null) return null
    if (typeof addr === 'string') return addr
    try {
      return JSON.stringify(addr)
    } catch {
      return String(addr)
    }
  }

  let lineItems = raw.line_items ?? []
  if (typeof lineItems === 'string') {
    try {
      lineItems = JSON.parse(lineItems)
    } catch {
      lineItems = []
    }
  }
  if (!Array.isArray(lineItems)) {
    lineItems = []
  }

  const customerName =
    raw.customer_name ||
    [raw.billing_first_name, raw.billing_last_name].filter(Boolean).join(' ').trim() ||
    null

  const dateCreated = raw.date_created || raw.created_at || null

  return {
    ok: true,
    row: {
      woo_order_id: wooOrderId,
      order_number: raw.order_number != null ? String(raw.order_number) : String(wooOrderId),
      status,
      currency: raw.currency ? String(raw.currency) : 'USD',
      total,
      subtotal: toMoney(raw.subtotal),
      tax_total: toMoney(raw.tax_total),
      shipping_total: toMoney(raw.shipping_total),
      customer_email: raw.customer_email || null,
      customer_name: customerName,
      billing_address: addressToText(raw.billing_address),
      shipping_address: addressToText(raw.shipping_address),
      line_items: lineItems,
      payment_method: raw.payment_method || null,
      payment_method_title: raw.payment_method_title || null,
      date_created: dateCreated,
    },
  }
}

/**
 * Upsert one or more orders for a store.
 *
 * @param {number} storeId
 * @param {object[]} rawOrders
 * @returns {Promise<{ imported: number, updated: number, errors: string[] }>}
 */
async function upsertOrders(storeId, rawOrders) {
  let imported = 0
  let updated = 0
  const errors = []

  for (const raw of rawOrders) {
    const normalized = normalizeOrder(raw)
    if (!normalized.ok) {
      errors.push(normalized.error)
      continue
    }

    const o = normalized.row

    try {
      const existing = await db.query(
        'SELECT id FROM orders WHERE store_id = $1 AND woo_order_id = $2 LIMIT 1',
        [storeId, o.woo_order_id]
      )

      if (existing.rows.length > 0) {
        await db.query(
          `UPDATE orders SET
             order_number = $1,
             status = $2,
             currency = $3,
             total = $4,
             subtotal = $5,
             tax_total = $6,
             shipping_total = $7,
             customer_email = $8,
             customer_name = $9,
             billing_address = $10,
             shipping_address = $11,
             line_items = $12::jsonb,
             payment_method = $13,
             payment_method_title = $14,
             updated_at = CURRENT_TIMESTAMP,
             synced_at = CURRENT_TIMESTAMP
           WHERE store_id = $15 AND woo_order_id = $16`,
          [
            o.order_number,
            o.status,
            o.currency,
            o.total,
            o.subtotal,
            o.tax_total,
            o.shipping_total,
            o.customer_email,
            o.customer_name,
            o.billing_address,
            o.shipping_address,
            JSON.stringify(o.line_items),
            o.payment_method,
            o.payment_method_title,
            storeId,
            o.woo_order_id,
          ]
        )
        updated += 1
      } else {
        await db.query(
          `INSERT INTO orders (
             store_id, woo_order_id, order_number, status, currency, total,
             subtotal, tax_total, shipping_total, customer_email, customer_name,
             billing_address, shipping_address, line_items, payment_method,
             payment_method_title, created_at, updated_at, synced_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12, $13, $14::jsonb, $15,
             $16,
             COALESCE($17::timestamptz, CURRENT_TIMESTAMP),
             CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP
           )`,
          [
            storeId,
            o.woo_order_id,
            o.order_number,
            o.status,
            o.currency,
            o.total,
            o.subtotal,
            o.tax_total,
            o.shipping_total,
            o.customer_email,
            o.customer_name,
            o.billing_address,
            o.shipping_address,
            JSON.stringify(o.line_items),
            o.payment_method,
            o.payment_method_title,
            o.date_created,
          ]
        )
        imported += 1
      }
    } catch (err) {
      errors.push(`Order ${o.woo_order_id}: ${err.message}`)
    }
  }

  return { imported, updated, errors }
}

module.exports = { normalizeOrder, upsertOrders }
