import { requireAdmin } from '../../../../../lib/auth'
import db from '../../../../../lib/db'
import { redirect } from 'next/navigation'
import ProductDetail from '../../../../../components/product-detail'
import { getStorePricingContext } from '../../../../../lib/app-settings'

export default async function ProductDetailPage({ params }) {
  const session = await requireAdmin()
  const { id, productId: productIdParam } = await params
  const storeId = parseInt(id)
  const productId = parseInt(productIdParam)

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

  const storeResult = await db.query(
    'SELECT connection_method, price_rule_percent FROM stores WHERE id = $1',
    [storeId]
  )
  const store = storeResult.rows[0] || {}
  const connectionMethod = store.connection_method
  const pricing = await getStorePricingContext(store)
  const priceRulePercent = pricing.effective

  // Get product (approval is global - see export/products/route.js;
  // product_stores is joined only for this store's own woo_product_id)
  const productResult = await db.query(
    `SELECT p.id, p.sku, p.name, p.description, p.short_description, p.price, p.regular_price,
            p.sale_price, p.stock_quantity, p.manage_stock, p.stock_status, p.categories,
            p.tags, p.images, p.attributes, p.status, p.created_at, p.reviewed_at, ps.woo_product_id
     FROM products p
     LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $2
     WHERE p.id = $1`,
    [productId, storeId]
  )

  if (productResult.rows.length === 0) {
    redirect(`/admin/store/${storeId}/products`)
  }

  const product = productResult.rows[0]

  // Get variations
  const variationsResult = await db.query(
    `SELECT id, sku, attributes, size, color, price, regular_price, sale_price, 
            stock_quantity, stock_status, tax_class, image, images, status
     FROM product_variations
     WHERE product_id = $1
     ORDER BY created_at DESC`,
    [productId]
  )

  return (
    <div>
      <div className="mb-6">
        <a
          href={`/admin/store/${storeId}/products`}
          className="text-indigo-600 hover:text-indigo-800 mb-2 inline-block"
        >
          ← Back to Products
        </a>
        <h1 className="text-3xl font-bold text-gray-900 mt-2">{product.name}</h1>
      </div>
      <ProductDetail
        storeId={storeId}
        connectionMethod={connectionMethod}
        priceRulePercent={priceRulePercent}
        product={product}
        variations={variationsResult.rows}
      />
    </div>
  )
}


