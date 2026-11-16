'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney, resolveCostPrice, resolveStorePrice } from '@/app/lib/pricing'
import ProductPriceOverrideCard from '@/app/components/ProductPriceOverrideCard'

const VAR_PAGE_SIZE = 25

export default function ProductDetail({ storeId, connectionMethod, priceRulePercent = null, product, variations }) {
  const isPluginStore = connectionMethod === 'plugin'
  const storePricing = useMemo(() => ({ price_rule_percent: priceRulePercent }), [priceRulePercent])
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editMode, setEditMode] = useState(false)

  // ── Variation filter state ────────────────────────────────────────────────
  const [filterSize, setFilterSize] = useState('')
  const [filterColor, setFilterColor] = useState('')
  const [filterCostMin, setFilterCostMin] = useState('')
  const [filterCostMax, setFilterCostMax] = useState('')
  const [filterPriceMin, setFilterPriceMin] = useState('')
  const [filterPriceMax, setFilterPriceMax] = useState('')
  const [sortField, setSortField] = useState(null) // 'cost' | 'storePrice' | null
  const [sortDir, setSortDir] = useState('asc')
  const [varPage, setVarPage] = useState(1)
  const [formData, setFormData] = useState({
    name: product.name,
    sku: product.sku,
    description: product.description || '',
    short_description: product.short_description || '',
    price: product.price || '',
    regular_price: product.regular_price || '',
    sale_price: product.sale_price || '',
    stock_quantity: product.stock_quantity || '',
    stock_status: product.stock_status || 'instock',
    categories: product.categories || '',
    tags: product.tags || '',
  })

  // ── Derived filter options ────────────────────────────────────────────────
  const distinctSizes = useMemo(() => {
    const s = new Set()
    variations.forEach((v) => { if (v.size) s.add(v.size.trim()) })
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [variations])

  const distinctColors = useMemo(() => {
    const s = new Set()
    variations.forEach((v) => { if (v.color) s.add(v.color.trim()) })
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [variations])

  const hasActiveFilters =
    filterSize !== '' ||
    filterColor !== '' ||
    filterCostMin !== '' ||
    filterCostMax !== '' ||
    filterPriceMin !== '' ||
    filterPriceMax !== ''

  const clearFilters = () => {
    setFilterSize('')
    setFilterColor('')
    setFilterCostMin('')
    setFilterCostMax('')
    setFilterPriceMin('')
    setFilterPriceMax('')
    setSortField(null)
    setSortDir('asc')
    setVarPage(1)
  }

  // ── Filtered + sorted variations (whole dataset, before pagination) ───────
  const filteredVariations = useMemo(() => {
    const costMinNum = filterCostMin !== '' ? parseFloat(filterCostMin) : null
    const costMaxNum = filterCostMax !== '' ? parseFloat(filterCostMax) : null
    const priceMinNum = filterPriceMin !== '' ? parseFloat(filterPriceMin) : null
    const priceMaxNum = filterPriceMax !== '' ? parseFloat(filterPriceMax) : null

    let result = variations.filter((v) => {
      if (filterSize && (!v.size || v.size.trim().toLowerCase() !== filterSize.toLowerCase())) return false
      if (filterColor && (!v.color || v.color.trim().toLowerCase() !== filterColor.toLowerCase())) return false

      const cost = resolveCostPrice(v)
      if (costMinNum !== null && !Number.isNaN(costMinNum)) {
        if (cost === null || cost < costMinNum) return false
      }
      if (costMaxNum !== null && !Number.isNaN(costMaxNum)) {
        if (cost === null || cost > costMaxNum) return false
      }

      // Use the identical resolveStorePrice call that the display column uses
      const storePrice = resolveStorePrice(v, storePricing)
      if (priceMinNum !== null && !Number.isNaN(priceMinNum)) {
        if (storePrice === null || storePrice < priceMinNum) return false
      }
      if (priceMaxNum !== null && !Number.isNaN(priceMaxNum)) {
        if (storePrice === null || storePrice > priceMaxNum) return false
      }

      return true
    })

    if (sortField) {
      result = [...result].sort((a, b) => {
        const aVal = sortField === 'cost' ? resolveCostPrice(a) : resolveStorePrice(a, storePricing)
        const bVal = sortField === 'cost' ? resolveCostPrice(b) : resolveStorePrice(b, storePricing)
        if (aVal === null && bVal === null) return 0
        if (aVal === null) return 1
        if (bVal === null) return -1
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal
      })
    }

    return result
  }, [variations, filterSize, filterColor, filterCostMin, filterCostMax, filterPriceMin, filterPriceMax, sortField, sortDir, storePricing])

  const totalVarPages = Math.max(1, Math.ceil(filteredVariations.length / VAR_PAGE_SIZE))
  const paginatedVariations = useMemo(() => {
    const start = (varPage - 1) * VAR_PAGE_SIZE
    return filteredVariations.slice(start, start + VAR_PAGE_SIZE)
  }, [filteredVariations, varPage])

  const handleFilterChange = (setter) => (val) => {
    setter(val)
    setVarPage(1)
  }

  const handleSortToggle = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
    setVarPage(1)
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span className="ml-1 text-gray-300">↕</span>
    return <span className="ml-1 text-indigo-600">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const getStatusBadge = (status) => {
    const colors = {
      pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      synced: 'bg-blue-100 text-blue-800',
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status] || colors.pending}`}>
        {status}
      </span>
    )
  }

  const handleSave = async () => {
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update product')
      }

      setEditMode(false)
      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const handleStatusChange = async (newStatus) => {
    if (!confirm(`Are you sure you want to ${newStatus} this product?`)) {
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/products/${product.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, store_id: storeId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update product status')
      }

      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const handlePublish = async () => {
    if (!confirm('Are you sure you want to publish this product to WooCommerce?')) {
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/sync/product/${product.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to publish product to WooCommerce')
      }

      const result = await response.json()
      alert(result.message || 'Product published successfully!')
      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="mb-4 flex justify-between items-center">
        <div>Status: {getStatusBadge(product.status)}</div>
        <div className="space-x-2">
          {!editMode ? (
            <>
              <button
                onClick={() => setEditMode(true)}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
              >
                Edit
              </button>
              {product.status === 'pending' && (
                <>
                  <button
                    onClick={() => handleStatusChange('approved')}
                    disabled={loading}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleStatusChange('rejected')}
                    disabled={loading}
                    className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </>
              )}
              {product.status !== 'rejected' && (
                isPluginStore ? (
                  <span className="text-sm text-gray-500 italic">
                    Pulled automatically by the WooApp Connector plugin
                  </span>
                ) : (
                  <button
                    onClick={handlePublish}
                    disabled={loading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                  >
                    {loading ? 'Publishing...' : 'Publish'}
                  </button>
                )
              )}
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setEditMode(false)
                  setFormData({
                    name: product.name,
                    sku: product.sku,
                    description: product.description || '',
                    short_description: product.short_description || '',
                    price: product.price || '',
                    regular_price: product.regular_price || '',
                    sale_price: product.sale_price || '',
                    stock_quantity: product.stock_quantity || '',
                    stock_status: product.stock_status || 'instock',
                    categories: product.categories || '',
                    tags: product.tags || '',
                  })
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
          {editMode ? (
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{product.name}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">SKU</label>
          {editMode ? (
            <input
              type="text"
              value={formData.sku || ''}
              onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{product.sku || '-'}</p>
          )}
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          {editMode ? (
            <textarea
              rows="4"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900 whitespace-pre-wrap">{product.description || '-'}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Cost (Ralawise)</label>
          {editMode ? (
            <input
              type="number"
              step="0.01"
              value={formData.regular_price || formData.price || ''}
              onChange={(e) => setFormData({
                ...formData,
                regular_price: e.target.value,
                price: e.target.value,
              })}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{formatMoney(resolveCostPrice(product))}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Store price</label>
          <p className="text-gray-900 font-medium">
            {formatMoney(resolveStorePrice(
              editMode
                ? { regular_price: formData.regular_price || formData.price, price: formData.price }
                : product,
              storePricing
            ))}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {priceRulePercent !== null && priceRulePercent !== undefined && priceRulePercent !== ''
              ? `Computed from cost with +${priceRulePercent}% markup`
              : 'No price rule set — same as cost'}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Stock Quantity</label>
          {editMode ? (
            <input
              type="number"
              value={formData.stock_quantity || ''}
              onChange={(e) => setFormData({ ...formData, stock_quantity: e.target.value })}
              className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          ) : (
            <p className="text-gray-900">{product.stock_quantity !== null ? product.stock_quantity : '-'}</p>
          )}
        </div>
      </div>

      {variations.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-medium mb-3">Variations</h3>

          {/* ── Filter Toolbar ─────────────────────────────────────────────── */}
          <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded-lg flex flex-wrap items-end gap-3 text-xs">
            {/* Size */}
            {distinctSizes.length > 0 && (
              <div className="flex flex-col gap-1 min-w-[110px]">
                <label className="font-semibold text-gray-600 uppercase tracking-wide">Size</label>
                <select
                  value={filterSize}
                  onChange={(e) => handleFilterChange(setFilterSize)(e.target.value)}
                  className="px-2 py-1.5 border border-gray-300 rounded bg-white text-gray-800"
                >
                  <option value="">All sizes</option>
                  {distinctSizes.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Color */}
            {distinctColors.length > 0 && (
              <div className="flex flex-col gap-1 min-w-[130px]">
                <label className="font-semibold text-gray-600 uppercase tracking-wide">Colour</label>
                <select
                  value={filterColor}
                  onChange={(e) => handleFilterChange(setFilterColor)(e.target.value)}
                  className="px-2 py-1.5 border border-gray-300 rounded bg-white text-gray-800"
                >
                  <option value="">All colours</option>
                  {distinctColors.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Cost range */}
            <div className="flex flex-col gap-1">
              <label className="font-semibold text-gray-600 uppercase tracking-wide">Cost (£)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={filterCostMin}
                  onChange={(e) => handleFilterChange(setFilterCostMin)(e.target.value)}
                  placeholder="Min"
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded font-mono"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={filterCostMax}
                  onChange={(e) => handleFilterChange(setFilterCostMax)(e.target.value)}
                  placeholder="Max"
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded font-mono"
                />
              </div>
            </div>

            {/* Store price range */}
            <div className="flex flex-col gap-1">
              <label className="font-semibold text-gray-600 uppercase tracking-wide">Store Price (£)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={filterPriceMin}
                  onChange={(e) => handleFilterChange(setFilterPriceMin)(e.target.value)}
                  placeholder="Min"
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded font-mono"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={filterPriceMax}
                  onChange={(e) => handleFilterChange(setFilterPriceMax)(e.target.value)}
                  placeholder="Max"
                  className="w-20 px-2 py-1.5 border border-gray-300 rounded font-mono"
                />
              </div>
            </div>

            {/* Clear */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="self-end px-3 py-1.5 bg-white border border-gray-300 rounded text-gray-700 hover:bg-gray-100 font-medium"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* ── Summary row ───────────────────────────────────────────────── */}
          <p className="mb-2 text-xs text-gray-500">
            Showing <strong>{filteredVariations.length}</strong> of <strong>{variations.length}</strong> variations
            {totalVarPages > 1 && (
              <span className="ml-1">(page {varPage} of {totalVarPages})</span>
            )}
          </p>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">SKU</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Color</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Attributes</th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-indigo-600"
                    onClick={() => handleSortToggle('cost')}
                  >
                    Cost <SortIcon field="cost" />
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-indigo-600"
                    onClick={() => handleSortToggle('storePrice')}
                  >
                    Store price <SortIcon field="storePrice" />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stock</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tax class</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Images</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedVariations.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-10 text-center text-sm text-gray-400">
                      No variations match the current filters.{' '}
                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={clearFilters}
                          className="text-indigo-600 hover:underline font-medium"
                        >
                          Clear filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  paginatedVariations.map((variation) => (
                    <tr key={variation.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {variation.sku || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variation.size || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variation.color || '-'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {variation.attributes || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatMoney(resolveCostPrice(variation))}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                        {formatMoney(resolveStorePrice(variation, storePricing))}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variation.stock_quantity !== null ? variation.stock_quantity : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variation.tax_class || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {variation.images
                          ? `${String(variation.images).split(',').filter(Boolean).length}`
                          : variation.image
                            ? '1'
                            : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getStatusBadge(variation.status)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* ── Pagination ─────────────────────────────────────────────────── */}
          {totalVarPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
              <span>
                {(varPage - 1) * VAR_PAGE_SIZE + 1}–{Math.min(filteredVariations.length, varPage * VAR_PAGE_SIZE)} of {filteredVariations.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={varPage <= 1}
                  onClick={() => setVarPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 bg-white border border-gray-300 rounded font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="font-semibold">Page {varPage} of {totalVarPages}</span>
                <button
                  type="button"
                  disabled={varPage >= totalVarPages}
                  onClick={() => setVarPage((p) => Math.min(totalVarPages, p + 1))}
                  className="px-3 py-1.5 bg-white border border-gray-300 rounded font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}






