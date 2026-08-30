import { requireAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import ProductReview from '../../../../components/product-review'
import { VENDOR_STORE_JOIN } from '../../../../lib/vendor-store-filter'
import { getStorePricingContext } from '../../../../lib/app-settings'

export default async function ProductsPage({ params, searchParams }) {
  const session = await requireAdmin()
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const storeId = parseInt(id)
  const isStoreAdmin = session.user.role === 'admin'
  const status = resolvedSearchParams?.status || (isStoreAdmin ? 'all' : 'pending')
  const page = parseInt(resolvedSearchParams?.page || '1')
  const limit = parseInt(resolvedSearchParams?.limit || '50')
  const search = resolvedSearchParams?.search || ''
  const brand = resolvedSearchParams?.brand || ''
  const category = resolvedSearchParams?.category || ''
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
    'SELECT id, name, connection_method, price_rule_percent FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]
  const pricing = await getStorePricingContext(store)
  const vendorJoin = isStoreAdmin ? VENDOR_STORE_JOIN : ''

  function buildFilterParts(startIndex) {
    const parts = []
    const params = []
    let paramIndex = startIndex

    if (isStoreAdmin) {
      parts.push('vs.id IS NOT NULL')
    }

    if (status !== 'all') {
      parts.push(`p.status = $${paramIndex}`)
      params.push(status)
      paramIndex++
    }

    if (search && search.trim()) {
      parts.push(
        `(LOWER(p.name) LIKE LOWER($${paramIndex}) OR LOWER(p.sku) LIKE LOWER($${paramIndex}))`
      )
      params.push(`%${search.trim()}%`)
      paramIndex++
    }

    if (brand && brand.trim()) {
      parts.push(`p.brand = $${paramIndex}`)
      params.push(brand.trim())
      paramIndex++
    }

    if (category && category.trim()) {
      parts.push(
        `EXISTS (SELECT 1 FROM unnest(string_to_array(p.categories, ',')) cat WHERE LOWER(TRIM(cat)) = LOWER($${paramIndex}))`
      )
      params.push(category.trim())
      paramIndex++
    }

    return { parts, params, nextIndex: paramIndex }
  }

  const listFilters = buildFilterParts(2)
  const whereClause =
    listFilters.parts.length > 0 ? `WHERE ${listFilters.parts.join(' AND ')}` : ''

  const queryParams = [storeId, ...listFilters.params, limit, offset]
  const limitIndex = listFilters.nextIndex
  const offsetIndex = listFilters.nextIndex + 1

  const productsResult = await db.query(
    `SELECT p.id, p.sku, p.name, p.price, p.regular_price, p.sale_price, p.stock_quantity,
            p.status, p.created_at, p.reviewed_at, p.brand, p.categories, p.images, ps.woo_product_id,
            ps.status AS store_status, ps.removed_at,
            COALESCE(v.variant_count, 0) as variant_count,
            v.min_cost_price,
            v.first_variant_image,
            ven.name AS vendor_name
     FROM products p
     LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
     LEFT JOIN vendors ven ON ven.id = p.vendor_id
     ${vendorJoin}
     LEFT JOIN (
       SELECT product_id,
              COUNT(*) as variant_count,
              MIN(COALESCE(regular_price, price)) as min_cost_price,
              MIN(CASE WHEN image IS NOT NULL AND image != '' THEN image ELSE NULL END) as first_variant_image
       FROM product_variations
       GROUP BY product_id
     ) v ON v.product_id = p.id
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    queryParams
  )

  const countStartIndex = isStoreAdmin ? 2 : 1
  const countFilters = buildFilterParts(countStartIndex)
  const countWhereClause =
    countFilters.parts.length > 0 ? `WHERE ${countFilters.parts.join(' AND ')}` : ''
  const countParams = isStoreAdmin
    ? [storeId, ...countFilters.params]
    : countFilters.params

  const countResult = await db.query(
    `SELECT COUNT(*) as total
     FROM products p
     ${vendorJoin}
     ${countWhereClause}`,
    countParams
  )

  const total = parseInt(countResult.rows[0].total)
  const totalPages = Math.ceil(total / limit)

  const brandsResult = await db.query(
    `SELECT DISTINCT p.brand
     FROM products p
     ${vendorJoin}
     WHERE p.brand IS NOT NULL AND p.brand != ''
     ORDER BY p.brand ASC`,
    isStoreAdmin ? [storeId] : []
  )
  const brands = brandsResult.rows.map((row) => row.brand)

  const categoriesResult = await db.query(
    `SELECT DISTINCT p.categories
     FROM products p
     ${vendorJoin}
     WHERE p.categories IS NOT NULL AND p.categories != ''`,
    isStoreAdmin ? [storeId] : []
  )

  const categoriesSet = new Set()
  categoriesResult.rows.forEach((row) => {
    if (row.categories) {
      String(row.categories)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .forEach((c) => categoriesSet.add(c))
    }
  })
  const categories = Array.from(categoriesSet).sort((a, b) => a.localeCompare(b))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          {isStoreAdmin ? 'Products' : 'Review Products'}
        </h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
        {pricing.effective !== null && pricing.effective !== undefined && (
          <p className="text-sm text-indigo-600 mt-1">
            Price rule: +{pricing.effective}% markup on cost
            {pricing.isOverride ? ' (store override)' : ' (default)'}
          </p>
        )}
        {isStoreAdmin && (
          <p className="text-sm text-gray-500 mt-1">
            Showing products from vendors assigned to this store.
          </p>
        )}
      </div>
      <ProductReview
        storeId={storeId}
        connectionMethod={store.connection_method}
        priceRulePercent={pricing.effective}
        products={productsResult.rows}
        status={status}
        currentPage={page}
        totalPages={totalPages}
        total={total}
        limit={limit}
        search={search}
        brand={brand}
        brands={brands}
        category={category}
        categories={categories}
        userRole={session.user.role}
        canApprove={!isStoreAdmin}
        canSync={isStoreAdmin}
      />
    </div>
  )
}
