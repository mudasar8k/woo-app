'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { applyPriceRule, formatMoney, resolveCostPrice, resolveStorePrice, resolveItemPrice } from '@/app/lib/pricing'
import ProductPriceOverrideModal from '@/app/components/ProductPriceOverrideModal'

export default function ProductReview({
  storeId,
  connectionMethod,
  priceRulePercent = null,
  storePricingContext = null,
  rangeRules = [],
  categoryRules = [],
  products,
  status,
  currentPage,
  totalPages,
  total,
  limit = 50,
  search = '',
  brand = '',
  brands = [],
  category = '',
  categories = [],
  canApprove = true,
  canSync = true,
}) {
  const isPluginStore = connectionMethod === 'plugin'
  const storePricing = { price_rule_percent: priceRulePercent }
  const router = useRouter()
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [pageInput, setPageInput] = useState(currentPage.toString())
  const [searchInput, setSearchInput] = useState(search)
  const [expandedProducts, setExpandedProducts] = useState(new Set())
  const [variantsData, setVariantsData] = useState({})
  const [selectedIds, setSelectedIds] = useState(new Set())
  const selectAllRef = useRef(null)
  const [removingProduct, setRemovingProduct] = useState(null)
  const [overrideModalProduct, setOverrideModalProduct] = useState(null)

  const getProductCost = (product) => {
    if (product.min_cost_price !== null && product.min_cost_price !== undefined) {
      return Number(product.min_cost_price)
    }
    return resolveCostPrice(product)
  }

  const getProductThumbnail = (product) => {
    if (product.images) {
      const list = String(product.images)
        .split(',')
        .map((img) => img.trim())
        .filter(Boolean)
      if (list.length > 0) return list[0]
    }
    if (product.first_variant_image) {
      return product.first_variant_image
    }
    return null
  }

  useEffect(() => {
    setSelectedIds(new Set())
  }, [storeId])

  const buildQuery = ({ page: newPage, newLimit, newSearch, newBrand, newCategory }) => {
    const params = new URLSearchParams()
    params.set('status', status)
    params.set('page', String(newPage))
    params.set('limit', String(newLimit ?? limit))
    const effectiveSearch = newSearch !== undefined ? newSearch : search
    const effectiveBrand = newBrand !== undefined ? newBrand : brand
    const effectiveCategory = newCategory !== undefined ? newCategory : category
    if (effectiveSearch) params.set('search', effectiveSearch)
    if (effectiveBrand) params.set('brand', effectiveBrand)
    if (effectiveCategory) params.set('category', effectiveCategory)
    return params.toString()
  }

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      router.push(`/admin/store/${storeId}/products?${buildQuery({ page: newPage })}`)
    }
  }

  const handleLimitChange = (newLimit) => {
    router.push(`/admin/store/${storeId}/products?${buildQuery({ page: 1, newLimit })}`)
  }

  const handleSearchSubmit = (e) => {
    e.preventDefault()
    router.push(`/admin/store/${storeId}/products?${buildQuery({ page: 1, newSearch: searchInput.trim() })}`)
  }

  const handleSearchClear = () => {
    setSearchInput('')
    router.push(`/admin/store/${storeId}/products?${buildQuery({ page: 1, newSearch: '' })}`)
  }

  const handleBrandChange = (newBrand) => {
    router.push(`/admin/store/${storeId}/products?${buildQuery({ page: 1, newBrand })}`)
  }

  const handleCategoryChange = (newCategory) => {
    router.push(`/admin/store/${storeId}/products?${buildQuery({ page: 1, newCategory })}`)
  }

  const handlePageInputSubmit = (e) => {
    e.preventDefault()
    const pageNum = parseInt(pageInput)
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
    } else {
      setPageInput(currentPage.toString())
    }
  }

  // Calculate visible page range
  const getVisiblePages = () => {
    const delta = 2 // Show 2 pages on each side of current
    const range = []
    const rangeWithDots = []

    for (let i = Math.max(2, currentPage - delta); 
         i <= Math.min(totalPages - 1, currentPage + delta); 
         i++) {
      range.push(i)
    }

    if (currentPage - delta > 2) {
      rangeWithDots.push(1, '...')
    } else {
      rangeWithDots.push(1)
    }

    rangeWithDots.push(...range)

    if (currentPage + delta < totalPages - 1) {
      rangeWithDots.push('...', totalPages)
    } else if (totalPages > 1) {
      rangeWithDots.push(totalPages)
    }

    return rangeWithDots
  }

  const startItem = total === 0 ? 0 : (currentPage - 1) * limit + 1
  const endItem = Math.min(currentPage * limit, total)

  const getStatusBadge = (productStatus) => {
    const colors = {
      pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      synced: 'bg-blue-100 text-blue-800',
    }
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[productStatus] || colors.pending}`}>
        {productStatus}
      </span>
    )
  }

  const handleStoreStatusChange = async (productId, action) => {
    setLoading(productId)
    setError('')
    setSuccess('')

    try {
      const response = await fetch(`/api/products/${productId}/store-status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, action }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update store status')
      }

      setSuccess(action === 'remove' ? 'Product removed from store export.' : 'Product restored to store export.')
      setRemovingProduct(null)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(null)
    }
  }

  const handleStatusChange = async (productId, newStatus) => {
    setLoading(productId)
    setError('')

    try {
      const response = await fetch(`/api/products/${productId}/status`, {
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
      setLoading(null)
    }
  }

  const handleBulkAction = async (action) => {
    const selectedProducts = products.filter((p) => p.status === 'pending')
    
    if (selectedProducts.length === 0) {
      alert('No pending products to update')
      return
    }

    if (!confirm(`Are you sure you want to ${action} ${selectedProducts.length} products?`)) {
      return
    }

    setLoading('bulk')
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/products/bulk-status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: selectedProducts.map((p) => p.id),
          status: action === 'approve' ? 'approved' : 'rejected',
          store_id: storeId,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update products')
      }

      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleSyncProduct = async (productId) => {
    setLoading(productId)
    setError('')
    setSuccess('')

    try {
      const response = await fetch(`/api/sync/product/${productId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to sync product')
      }

      setSuccess('Product synced successfully!')
      setLoading(null)
      
      // Refresh page after a delay to show updated status
      setTimeout(() => {
        router.refresh()
      }, 1000)
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const handleExportToStore = async () => {
    const productIds = Array.from(selectedIds)

    if (productIds.length === 0) {
      alert('No products selected')
      return
    }

    if (!confirm(`Export ${productIds.length} selected product(s) to the store?`)) {
      return
    }

    setLoading('bulk')
    setError('')
    setSuccess('')

    try {
      if (isPluginStore) {
        const response = await fetch(`/api/stores/${storeId}/trigger-import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_resync: false,
            product_ids: productIds,
          }),
        })

        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || 'Failed to export products to store')
        }

        setSuccess(data.message || 'Products approved and ready for the store to import.')
      } else {
        let succeeded = 0
        let failed = 0

        for (const productId of productIds) {
          try {
            const response = await fetch(`/api/sync/product/${productId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ store_id: storeId }),
            })
            if (response.ok) {
              succeeded++
            } else {
              failed++
            }
          } catch {
            failed++
          }
        }

        setSuccess(`Exported to store! ${succeeded} succeeded, ${failed} failed.`)
      }

      setLoading(null)
      setSelectedIds(new Set())

      setTimeout(() => {
        router.refresh()
      }, 2000)
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const toggleVariants = async (productId) => {
    const newExpanded = new Set(expandedProducts)
    
    if (newExpanded.has(productId)) {
      // Collapse
      newExpanded.delete(productId)
    } else {
      // Expand - fetch variants if not already loaded
      newExpanded.add(productId)
      if (!variantsData[productId]) {
        try {
          const response = await fetch(`/api/products/${productId}/variations?store_id=${storeId}`)
          if (response.ok) {
            const data = await response.json()
            setVariantsData(prev => ({
              ...prev,
              [productId]: data.variations || []
            }))
          }
        } catch (err) {
          console.error('Error fetching variants:', err)
        }
      }
    }
    
    setExpandedProducts(newExpanded)
  }

  const toggleSelectOne = (productId) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(productId)) {
      newSelected.delete(productId)
    } else {
      newSelected.add(productId)
    }
    setSelectedIds(newSelected)
  }

  const isAllSelected = products.length > 0 && products.every((p) => selectedIds.has(p.id))
  const isPagePartiallySelected = products.some((p) => selectedIds.has(p.id)) && !isAllSelected
  const hasSelection = selectedIds.size > 0

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPagePartiallySelected
    }
  }, [isPagePartiallySelected])

  const toggleSelectAll = () => {
    const newSelected = new Set(selectedIds)
    if (isAllSelected) {
      products.forEach((p) => newSelected.delete(p.id))
    } else {
      products.forEach((p) => newSelected.add(p.id))
    }
    setSelectedIds(newSelected)
  }

  const clearAllSelection = () => {
    setSelectedIds(new Set())
  }

  const showCheckboxColumn = canApprove || canSync

  const handleBulkSelectedAction = async (action) => {
    const productIds = Array.from(selectedIds)

    if (productIds.length === 0) {
      alert('No products selected')
      return
    }

    if (!confirm(`Are you sure you want to ${action} ${productIds.length} selected products?`)) {
      return
    }

    setLoading('bulk')
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/products/bulk-status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds,
          status: action === 'approve' ? 'approved' : 'rejected',
          store_id: storeId,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update products')
      }

      setSelectedIds(new Set())
      router.refresh()
    } catch (err) {
      setError(err.message)
      setLoading(null)
    }
  }

  const statusTabHref = (newStatus) => {
    const params = new URLSearchParams()
    params.set('status', newStatus)
    params.set('limit', String(limit))
    if (search) params.set('search', search)
    if (brand) params.set('brand', brand)
    if (category) params.set('category', category)
    return `/admin/store/${storeId}/products?${params.toString()}`
  }

  return (
    <div>
      <div className="mb-4 flex justify-between items-center">
        <div className="flex space-x-2">
          <Link
            href={statusTabHref('all')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'all'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            All ({total})
          </Link>
          <Link
            href={statusTabHref('pending')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'pending'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Pending
          </Link>
          <Link
            href={statusTabHref('approved')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'approved'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Approved
          </Link>
          <Link
            href={statusTabHref('synced')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              status === 'synced'
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Synced
          </Link>
        </div>
        {status === 'pending' && canApprove && (
          <div className="flex space-x-2">
            {hasSelection && (
              <>
                <button
                  onClick={() => handleBulkSelectedAction('approve')}
                  disabled={loading === 'bulk'}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
                >
                  {loading === 'bulk' ? 'Processing...' : `Approve Selected (${selectedIds.size})`}
                </button>
                <button
                  onClick={() => handleBulkSelectedAction('reject')}
                  disabled={loading === 'bulk'}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {loading === 'bulk' ? 'Processing...' : `Reject Selected (${selectedIds.size})`}
                </button>
              </>
            )}
            <button
              onClick={() => handleBulkAction('approve')}
              disabled={loading === 'bulk'}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {loading === 'bulk' ? 'Processing...' : 'Approve All Pending'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          {success}
        </div>
      )}

      {/* Filter Row: Search | All Brands | All Categories */}
      <div className="mb-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1 min-w-0">
          <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md min-w-[200px]">
            <div className="relative">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by name or SKU..."
                className="w-full px-4 py-2 pl-10 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              {searchInput && (
                <button
                  type="button"
                  onClick={handleSearchClear}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </form>

          {brands.length > 0 && (
            <select
              value={brand}
              onChange={(e) => handleBrandChange(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
            >
              <option value="">All Brands</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}

          {categories.length > 0 && (
            <select
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>

        {hasSelection && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 whitespace-nowrap">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={clearAllSelection}
              disabled={loading === 'bulk'}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 font-medium whitespace-nowrap"
            >
              Clear Selection
            </button>
            {canSync && (
              <button
                onClick={handleExportToStore}
                disabled={loading === 'bulk'}
                className="px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium whitespace-nowrap"
              >
                {loading === 'bulk' ? 'Exporting...' : `Export to Store (${selectedIds.size})`}
              </button>
            )}
          </div>
        )}
      </div>

      {(search || brand || category) && (
        <div className="mb-4 text-sm text-gray-600 flex flex-wrap items-center gap-2">
          {search && (
            <span>
              Search: <span className="font-medium">"{search}"</span>
            </span>
          )}
          {search && (brand || category) && <span>&middot;</span>}
          {brand && (
            <span>
              Brand: <span className="font-medium">{brand}</span>
            </span>
          )}
          {brand && category && <span>&middot;</span>}
          {category && (
            <span>
              Category: <span className="font-medium">{category}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setSearchInput('')
              router.push(`/admin/store/${storeId}/products?status=${status}&limit=${limit}`)
            }}
            className="text-xs text-indigo-600 hover:text-indigo-800 ml-2 underline"
          >
            Clear filters
          </button>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {showCheckboxColumn && (
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all products on this page"
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </th>
              )}
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-14">
                Image
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                SKU
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Brand
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Vendor
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Variants
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Cost
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Store price
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider min-w-[130px]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {products.length === 0 ? (
              <tr>
                <td colSpan={showCheckboxColumn ? 11 : 10} className="px-6 py-4 text-center text-gray-500">
                  No products found.
                </td>
              </tr>
            ) : (
              products.map((product) => {
                const isExpanded = expandedProducts.has(product.id)
                const variants = variantsData[product.id] || []
                const variantCount = parseInt(product.variant_count) || 0
                const thumbnailUrl = getProductThumbnail(product)
                
                return (
                  <React.Fragment key={product.id}>
                    <tr className={isExpanded ? 'bg-gray-50' : ''}>
                      {showCheckboxColumn && (
                        <td className="px-3 py-3.5 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(product.id)}
                            onChange={() => toggleSelectOne(product.id)}
                            aria-label={`Select ${product.name}`}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>
                      )}
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        <Link
                          href={`/admin/store/${storeId}/products/${product.id}`}
                          className="block w-12 h-12 rounded-md overflow-hidden bg-gray-100 border border-gray-200 shrink-0 hover:opacity-80 transition-opacity"
                        >
                          {thumbnailUrl ? (
                            <img
                              src={thumbnailUrl}
                              alt={product.name || product.sku}
                              loading="lazy"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                e.currentTarget.onerror = null
                                e.currentTarget.style.display = 'none'
                                if (e.currentTarget.nextElementSibling) {
                                  e.currentTarget.nextElementSibling.style.display = 'flex'
                                }
                              }}
                            />
                          ) : null}
                          <div
                            className={`w-full h-full flex items-center justify-center text-gray-400 ${thumbnailUrl ? 'hidden' : 'flex'}`}
                            aria-label="No image available"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm font-medium text-gray-900">
                        {product.sku || '-'}
                      </td>
                      <td className="px-3 py-3.5 text-sm text-gray-900">
                        <Link
                          href={`/admin/store/${storeId}/products/${product.id}`}
                          className="text-indigo-600 hover:text-indigo-800 font-medium"
                        >
                          {product.name}
                        </Link>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm text-gray-500">
                        {product.brand || '-'}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm text-gray-500">
                        {product.vendor_name || '-'}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm text-gray-500">
                        {variantCount > 0 ? (
                          <button
                            onClick={() => toggleVariants(product.id)}
                            className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
                          >
                            <span>{variantCount}</span>
                            <svg
                              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm text-gray-500">
                        {formatMoney(getProductCost(product))}
                        {variantCount > 0 ? (
                          <span className="block text-xs text-gray-400">from</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm text-gray-900 font-medium">
                        {(() => {
                          const cost = getProductCost(product)
                          const overrideObj = product.override_type && product.override_type !== 'store_rules' ? {
                            override_type: product.override_type,
                            custom_markup_percent: product.custom_markup_percent !== null ? Number(product.custom_markup_percent) : null,
                            fixed_price: product.fixed_price !== null ? Number(product.fixed_price) : null,
                          } : null
                          const context = storePricingContext || { price_rule_percent: priceRulePercent, pricing_mode: 'legacy_markup' }
                          const resolved = resolveItemPrice(
                            cost,
                            context,
                            rangeRules,
                            overrideObj,
                            product.categories,
                            categoryRules
                          )

                          return (
                            <div>
                              <span className="font-bold">{formatMoney(resolved.sellingPrice)}</span>
                              {product.override_type === 'custom_markup' ? (
                                <span className="block mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800">
                                  Custom +{product.custom_markup_percent}%
                                </span>
                              ) : product.override_type === 'fixed_price' ? (
                                <span className="block mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                                  Fixed Override
                                </span>
                              ) : resolved.source === 'category_rule' ? (
                                <span className="block mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800">
                                  Cat: {resolved.matchedCategory} (+{resolved.appliedMarkup}%)
                                </span>
                              ) : (
                                <span className="block text-[10px] text-gray-400 font-normal">
                                  {context.pricing_mode === 'range_rules' ? 'Tiered rules' : 'Store rules'}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        {getStatusBadge(product.status)}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-sm font-medium">
                        <div className="flex flex-col items-start gap-1">
                          {product.status === 'pending' && canApprove && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleStatusChange(product.id, 'approved')}
                                disabled={loading === product.id}
                                className="text-green-600 hover:text-green-900 text-xs font-medium disabled:opacity-50"
                              >
                                {loading === product.id ? 'Processing...' : 'Approve'}
                              </button>
                              <button
                                onClick={() => handleStatusChange(product.id, 'rejected')}
                                disabled={loading === product.id}
                                className="text-red-600 hover:text-red-900 text-xs font-medium disabled:opacity-50"
                              >
                                {loading === product.id ? 'Processing...' : 'Reject'}
                              </button>
                            </div>
                          )}
                          {(product.status === 'approved' || product.status === 'synced') && (
                            product.store_status === 'removed' ? (
                              <div className="flex flex-col items-start gap-0.5">
                                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700 whitespace-nowrap">
                                  Removed from Store
                                </span>
                                <button
                                  onClick={() => handleStoreStatusChange(product.id, 'restore')}
                                  disabled={loading === product.id}
                                  className="text-indigo-600 hover:text-indigo-900 text-xs font-medium underline disabled:opacity-50 whitespace-nowrap"
                                >
                                  {loading === product.id ? 'Restoring...' : 'Restore to Store'}
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setRemovingProduct(product)}
                                disabled={loading === product.id}
                                className="text-red-600 hover:text-red-900 text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                              >
                                Remove from Store
                              </button>
                            )
                          )}
                          {isPluginStore && (
                            <span className="text-xs text-gray-400 whitespace-nowrap">Pulled by plugin</span>
                          )}
                          {!isPluginStore && product.status === 'approved' && canSync && (
                            <button
                              onClick={() => handleSyncProduct(product.id)}
                              disabled={loading === product.id}
                              className="text-indigo-600 hover:text-indigo-900 text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                            >
                              {loading === product.id ? 'Syncing...' : 'Sync to Store'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setOverrideModalProduct(product)}
                            className="text-indigo-600 hover:text-indigo-900 text-xs font-medium whitespace-nowrap flex items-center gap-1 mt-0.5"
                          >
                            <span>🏷️</span> Price Override
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-gray-50">
                        <td colSpan={showCheckboxColumn ? 11 : 10} className="px-6 py-4">
                          <div className="border border-gray-200 rounded-lg p-4 bg-white">
                            <h4 className="text-sm font-medium text-gray-900 mb-3">
                              Variants ({variantCount})
                            </h4>
                            {variants.length === 0 ? (
                              <div className="text-sm text-gray-500 py-2">
                                Loading variants...
                              </div>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-200">
                                  <thead className="bg-gray-50">
                                    <tr>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        SKU
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Size
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Color
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Cost
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Store price
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Stock
                                      </th>
                                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                                        Status
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="bg-white divide-y divide-gray-200">
                                    {variants.map((variant) => (
                                      <tr key={variant.id}>
                                        <td className="px-4 py-2 text-sm font-medium text-gray-900">
                                          {variant.sku}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-gray-500">{variant.size || '-'}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">{variant.color || '-'}</td>
                                        <td className="px-4 py-2 text-sm text-gray-500">
                                          {formatMoney(resolveCostPrice(variant))}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-gray-900 font-medium">
                                          {formatMoney(resolveStorePrice(variant, storePricing))}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-gray-500">
                                          {variant.stock_status || '-'}
                                        </td>
                                        <td className="px-4 py-2 text-sm">
                                          {getStatusBadge(variant.status)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination Info and Controls */}
      <div className="mt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-700">
            Showing <span className="font-medium">{startItem}</span> to <span className="font-medium">{endItem}</span> of{' '}
            <span className="font-medium">{total}</span> products
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="limit-select" className="text-sm text-gray-700">
              Per page:
            </label>
            <select
              id="limit-select"
              value={limit}
              onChange={(e) => handleLimitChange(parseInt(e.target.value))}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            {/* First Page */}
            <button
              onClick={() => handlePageChange(1)}
              disabled={currentPage === 1}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              First
            </button>

            {/* Previous Page */}
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>

            {/* Page Numbers */}
            <div className="flex items-center gap-1">
              {getVisiblePages().map((page, index) => {
                if (page === '...') {
                  return (
                    <span key={`ellipsis-${index}`} className="px-2 py-1 text-gray-500">
                      ...
                    </span>
                  )
                }
                return (
                  <button
                    key={page}
                    onClick={() => handlePageChange(page)}
                    className={`px-3 py-1 text-sm font-medium rounded-md ${
                      page === currentPage
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {page}
                  </button>
                )
              })}
            </div>

            {/* Next Page */}
            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>

            {/* Last Page */}
            <button
              onClick={() => handlePageChange(totalPages)}
              disabled={currentPage === totalPages}
              className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Last
            </button>

            {/* Page Input */}
            <form onSubmit={handlePageInputSubmit} className="flex items-center gap-2 ml-2">
              <span className="text-sm text-gray-700">Go to:</span>
              <input
                type="number"
                min="1"
                max={totalPages}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                className="px-3 py-1 text-sm font-medium text-indigo-600 bg-white border border-indigo-300 rounded-md hover:bg-indigo-50"
              >
                Go
              </button>
            </form>
          </div>
        )}
      </div>

      {removingProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              Remove {removingProduct.sku || removingProduct.name} from Store?
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              This product will no longer be exported to this store and will be moved to Trash in the live WooCommerce catalog on the next sync.
              <br /><br />
              <span className="font-semibold text-gray-800">The master WooApp catalog product will not be deleted.</span>
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRemovingProduct(null)}
                disabled={loading === removingProduct.id}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleStoreStatusChange(removingProduct.id, 'remove')}
                disabled={loading === removingProduct.id}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                {loading === removingProduct.id ? 'Removing...' : 'Remove from Store'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
