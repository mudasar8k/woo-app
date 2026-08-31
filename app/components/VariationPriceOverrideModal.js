'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { formatMoney, toNumber, round2 } from '@/app/lib/pricing'

const ITEMS_PER_PAGE = 25

export default function VariationPriceOverrideModal({
  isOpen,
  onClose,
  storeId,
  productId,
  product,
  onSaved,
}) {
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [variationsData, setVariationsData] = useState([])
  const [productData, setProductData] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Search and filter state
  const [search, setSearch] = useState('')
  const [colorFilter, setColorFilter] = useState('all')
  const [sizeFilter, setSizeFilter] = useState('all')
  const [page, setPage] = useState(1)

  // Local edits map: variationId => { override_type, custom_markup_percent, fixed_price }
  const [rowEdits, setRowEdits] = useState({})
  const [savingRowId, setSavingRowId] = useState(null)

  // Bulk selection
  const [selectedVarIds, setSelectedVarIds] = useState(new Set())
  const [bulkType, setBulkType] = useState('custom_markup')
  const [bulkValue, setBulkValue] = useState('')
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [bulkAction, setBulkAction] = useState(null) // 'apply' | 'reset'

  // Fetch variations pricing context on open
  useEffect(() => {
    if (!isOpen || !productId) return

    setError('')
    setSuccess('')
    setFetching(true)
    setPage(1)
    setSelectedVarIds(new Set())

    async function loadVariations() {
      try {
        const res = await fetch(`/api/products/${productId}/variations/store-pricing?store_id=${storeId}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load variations pricing')
        }

        setProductData(data.product || product || {})
        const vars = data.variations || []
        setVariationsData(vars)

        // Initialize local edits from server state
        const initialEdits = {}
        vars.forEach((v) => {
          initialEdits[v.id] = {
            override_type: v.override?.override_type || 'product_rules',
            custom_markup_percent:
              v.override?.custom_markup_percent !== null && v.override?.custom_markup_percent !== undefined
                ? String(v.override.custom_markup_percent)
                : '',
            fixed_price:
              v.override?.fixed_price !== null && v.override?.fixed_price !== undefined
                ? String(v.override.fixed_price)
                : '',
          }
        })
        setRowEdits(initialEdits)
      } catch (err) {
        console.error('Error loading variations pricing:', err)
        setError(err.message || 'Failed to load variations')
      } finally {
        setFetching(false)
      }
    }

    loadVariations()
  }, [isOpen, productId, storeId])

  // Extract distinct colors and sizes for filter dropdowns
  const { distinctColors, distinctSizes } = useMemo(() => {
    const colors = new Set()
    const sizes = new Set()
    variationsData.forEach((v) => {
      if (v.color) colors.add(v.color.trim())
      if (v.size) sizes.add(v.size.trim())
    })
    return {
      distinctColors: Array.from(colors).sort((a, b) => a.localeCompare(b)),
      distinctSizes: Array.from(sizes).sort((a, b) => a.localeCompare(b)),
    }
  }, [variationsData])

  // Filtered variations based on search, color, size
  const filteredVariations = useMemo(() => {
    return variationsData.filter((v) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const matchSku = v.sku && v.sku.toLowerCase().includes(q)
        const matchColor = v.color && v.color.toLowerCase().includes(q)
        const matchSize = v.size && v.size.toLowerCase().includes(q)
        if (!matchSku && !matchColor && !matchSize) return false
      }
      if (colorFilter !== 'all' && v.color !== colorFilter) return false
      if (sizeFilter !== 'all' && v.size !== sizeFilter) return false
      return true
    })
  }, [variationsData, search, colorFilter, sizeFilter])

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(filteredVariations.length / ITEMS_PER_PAGE))
  const paginatedVariations = useMemo(() => {
    const start = (page - 1) * ITEMS_PER_PAGE
    return filteredVariations.slice(start, start + ITEMS_PER_PAGE)
  }, [filteredVariations, page])

  if (!isOpen || !product) return null

  const overriddenCount = variationsData.filter(
    (v) => v.override?.override_type && v.override.override_type !== 'product_rules'
  ).length

  // Handle single row edit change
  const handleRowEditChange = (varId, field, val) => {
    setRowEdits((prev) => ({
      ...prev,
      [varId]: {
        ...prev[varId],
        [field]: val,
      },
    }))
  }

  // Calculate live proposed price for a row
  const getRowCalculatedPrice = (v) => {
    const edit = rowEdits[v.id] || {}
    const type = edit.override_type || 'product_rules'
    const cost = v.supplier_cost

    if (type === 'fixed_price') {
      const fixed = toNumber(edit.fixed_price)
      return fixed !== null ? fixed : null
    }
    if (type === 'custom_markup') {
      const markup = toNumber(edit.custom_markup_percent)
      return markup !== null && cost !== null ? round2(cost * (1 + markup / 100)) : null
    }
    return v.selling_price
  }

  // Save single variation override
  const handleSaveSingleRow = async (v) => {
    const edit = rowEdits[v.id] || {}
    setSavingRowId(v.id)
    setError('')
    setSuccess('')

    try {
      const payload = {
        store_id: storeId,
        override_type: edit.override_type || 'product_rules',
      }

      if (edit.override_type === 'custom_markup') {
        const val = toNumber(edit.custom_markup_percent)
        if (val === null || val < 0) {
          throw new Error('Custom markup percent must be a non-negative number.')
        }
        payload.custom_markup_percent = val
      } else if (edit.override_type === 'fixed_price') {
        const val = toNumber(edit.fixed_price)
        if (val === null || val < 0) {
          throw new Error('Fixed price must be a non-negative number.')
        }
        payload.fixed_price = val
      }

      const res = await fetch(`/api/products/${productId}/variations/${v.id}/store-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save variation override')
      }

      // Update in local variationsData
      setVariationsData((prev) =>
        prev.map((item) =>
          item.id === v.id
            ? {
                ...item,
                override: data.override,
                selling_price: getRowCalculatedPrice(item),
                source:
                  data.override.override_type === 'custom_markup'
                    ? 'variation_custom_markup'
                    : data.override.override_type === 'fixed_price'
                    ? 'variation_fixed'
                    : item.source,
              }
            : item
        )
      )

      setSuccess(`Saved override for ${v.sku || `Variation #${v.id}`}`)
      if (onSaved) onSaved()
    } catch (err) {
      setError(err.message || 'Failed to save override')
    } finally {
      setSavingRowId(null)
    }
  }

  // Reset single variation override
  const handleResetSingleRow = async (v) => {
    setSavingRowId(v.id)
    setError('')
    setSuccess('')

    try {
      const res = await fetch(`/api/products/${productId}/variations/${v.id}/store-pricing?store_id=${storeId}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset variation override')
      }

      // Reset in local state
      setRowEdits((prev) => ({
        ...prev,
        [v.id]: {
          override_type: 'product_rules',
          custom_markup_percent: '',
          fixed_price: '',
        },
      }))

      // Refetch variation pricing context to restore exact parent fallback price
      const getRes = await fetch(`/api/products/${productId}/variations/${v.id}/store-pricing?store_id=${storeId}`)
      if (getRes.ok) {
        const updated = await getRes.json()
        setVariationsData((prev) =>
          prev.map((item) => (item.id === v.id ? { ...item, ...updated } : item))
        )
      }

      setSuccess(`Reset ${v.sku || `Variation #${v.id}`} to product pricing`)
      if (onSaved) onSaved()
    } catch (err) {
      setError(err.message || 'Failed to reset override')
    } finally {
      setSavingRowId(null)
    }
  }

  // Bulk Selection Handlers
  const toggleSelectAllPage = () => {
    const pageIds = paginatedVariations.map((v) => v.id)
    const allSelected = pageIds.every((id) => selectedVarIds.has(id))
    setSelectedVarIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        pageIds.forEach((id) => next.delete(id))
      } else {
        pageIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const toggleSelectRow = (varId) => {
    setSelectedVarIds((prev) => {
      const next = new Set(prev)
      if (next.has(varId)) next.delete(varId)
      else next.add(varId)
      return next
    })
  }

  // Execute Bulk Action
  const executeBulkAction = async () => {
    setShowBulkConfirm(false)
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const selectedIds = Array.from(selectedVarIds)
      if (selectedIds.length === 0) return

      if (bulkAction === 'reset') {
        const res = await fetch(
          `/api/products/${productId}/variations/store-pricing?store_id=${storeId}&variation_ids=${selectedIds.join(',')}`,
          { method: 'DELETE' }
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to reset selected variations')

        // Refetch all to update state
        const refetchRes = await fetch(`/api/products/${productId}/variations/store-pricing?store_id=${storeId}`)
        if (refetchRes.ok) {
          const fresh = await refetchRes.json()
          setVariationsData(fresh.variations || [])
          const freshEdits = {}
          fresh.variations?.forEach((v) => {
            freshEdits[v.id] = {
              override_type: v.override?.override_type || 'product_rules',
              custom_markup_percent:
                v.override?.custom_markup_percent !== null ? String(v.override.custom_markup_percent) : '',
              fixed_price: v.override?.fixed_price !== null ? String(v.override.fixed_price) : '',
            }
          })
          setRowEdits(freshEdits)
        }
        setSuccess(`Successfully reset ${selectedIds.length} variations to product pricing.`)
      } else if (bulkAction === 'apply') {
        const overridesPayload = selectedIds.map((varId) => ({
          variation_id: varId,
          override_type: bulkType,
          custom_markup_percent: bulkType === 'custom_markup' ? Number(bulkValue) : null,
          fixed_price: bulkType === 'fixed_price' ? Number(bulkValue) : null,
        }))

        const res = await fetch(`/api/products/${productId}/variations/store-pricing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            store_id: storeId,
            overrides: overridesPayload,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to apply bulk override')

        // Refetch all to update state
        const refetchRes = await fetch(`/api/products/${productId}/variations/store-pricing?store_id=${storeId}`)
        if (refetchRes.ok) {
          const fresh = await refetchRes.json()
          setVariationsData(fresh.variations || [])
          const freshEdits = {}
          fresh.variations?.forEach((v) => {
            freshEdits[v.id] = {
              override_type: v.override?.override_type || 'product_rules',
              custom_markup_percent:
                v.override?.custom_markup_percent !== null ? String(v.override.custom_markup_percent) : '',
              fixed_price: v.override?.fixed_price !== null ? String(v.override.fixed_price) : '',
            }
          })
          setRowEdits(freshEdits)
        }
        setSuccess(`Successfully applied override to ${selectedIds.length} variations.`)
      }

      setSelectedVarIds(new Set())
      if (onSaved) onSaved()
    } catch (err) {
      setError(err.message || 'Bulk operation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-55 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[94vh] flex flex-col overflow-hidden border border-gray-200">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="p-5 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-gray-900">Variation Price Overrides</h3>
              <span className="px-2.5 py-0.5 rounded text-xs font-mono font-bold bg-indigo-100 text-indigo-800">
                {product.sku || 'No SKU'}
              </span>
              {overriddenCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                  {overriddenCount} overridden
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600 truncate max-w-2xl mt-0.5">
              {product.name} — Overrides set here take highest priority over product and store rules.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl font-bold p-1 rounded-md"
          >
            ✕
          </button>
        </div>

        {/* ── Feedback Banners ────────────────────────────────────────────── */}
        {error && (
          <div className="bg-red-50 border-b border-red-200 text-red-700 px-5 py-2 text-xs font-medium">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-emerald-50 border-b border-emerald-200 text-emerald-800 px-5 py-2 text-xs font-medium">
            {success}
          </div>
        )}

        {/* ── Filters & Search Toolbar ────────────────────────────────────── */}
        <div className="p-3.5 border-b border-gray-200 bg-white flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-sm">
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="Search SKU, colour, or size..."
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-2">
            {distinctColors.length > 0 && (
              <select
                value={colorFilter}
                onChange={(e) => {
                  setColorFilter(e.target.value)
                  setPage(1)
                }}
                className="px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white text-gray-700 font-medium"
              >
                <option value="all">All Colours ({distinctColors.length})</option>
                {distinctColors.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}

            {distinctSizes.length > 0 && (
              <select
                value={sizeFilter}
                onChange={(e) => {
                  setSizeFilter(e.target.value)
                  setPage(1)
                }}
                className="px-2.5 py-1.5 border border-gray-300 rounded-md text-xs bg-white text-gray-700 font-medium"
              >
                <option value="all">All Sizes ({distinctSizes.length})</option>
                {distinctSizes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Bulk Action Controls */}
          {selectedVarIds.size > 0 && (
            <div className="flex items-center gap-2 bg-indigo-50 px-3 py-1 rounded-md border border-indigo-200">
              <span className="font-bold text-indigo-900 text-xs">
                {selectedVarIds.size} selected:
              </span>
              <select
                value={bulkType}
                onChange={(e) => setBulkType(e.target.value)}
                className="px-2 py-1 border border-indigo-300 rounded bg-white text-xs"
              >
                <option value="custom_markup">Custom Markup %</option>
                <option value="fixed_price">Fixed Price £</option>
              </select>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bulkValue}
                onChange={(e) => setBulkValue(e.target.value)}
                placeholder={bulkType === 'custom_markup' ? '+250%' : '£14.99'}
                className="w-20 px-2 py-1 border border-indigo-300 rounded text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  if (!bulkValue || isNaN(bulkValue) || Number(bulkValue) < 0) {
                    setError('Enter a valid non-negative number for bulk apply.')
                    return
                  }
                  setBulkAction('apply')
                  setShowBulkConfirm(true)
                }}
                className="px-2.5 py-1 bg-indigo-600 text-white font-bold rounded text-xs hover:bg-indigo-700"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => {
                  setBulkAction('reset')
                  setShowBulkConfirm(true)
                }}
                className="px-2.5 py-1 bg-amber-600 text-white font-bold rounded text-xs hover:bg-amber-700"
              >
                Reset Selected
              </button>
            </div>
          )}
        </div>

        {/* ── Variations Table ────────────────────────────────────────────── */}
        <div className="overflow-y-auto flex-1 p-0">
          {fetching ? (
            <div className="py-16 text-center text-sm text-gray-500">
              Loading variations pricing...
            </div>
          ) : filteredVariations.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">
              No variations found matching filter.
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200 text-xs">
              <thead className="bg-gray-50 text-gray-700 font-semibold sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-3 py-2.5 text-center w-8">
                    <input
                      type="checkbox"
                      checked={
                        paginatedVariations.length > 0 &&
                        paginatedVariations.every((v) => selectedVarIds.has(v.id))
                      }
                      onChange={toggleSelectAllPage}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left">Variation / SKU</th>
                  <th className="px-3 py-2.5 text-left">Colour</th>
                  <th className="px-3 py-2.5 text-left">Size</th>
                  <th className="px-3 py-2.5 text-right">Cost</th>
                  <th className="px-3 py-2.5 text-right">Current Price</th>
                  <th className="px-3 py-2.5 text-left">Strategy</th>
                  <th className="px-3 py-2.5 text-left">Override Value</th>
                  <th className="px-3 py-2.5 text-right">Final Price</th>
                  <th className="px-3 py-2.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {paginatedVariations.map((v) => {
                  const edit = rowEdits[v.id] || {
                    override_type: 'product_rules',
                    custom_markup_percent: '',
                    fixed_price: '',
                  }
                  const isOverridden = edit.override_type !== 'product_rules'
                  const calculatedPrice = getRowCalculatedPrice(v)
                  const isSaving = savingRowId === v.id

                  return (
                    <tr
                      key={v.id}
                      className={`hover:bg-gray-50/80 transition ${
                        selectedVarIds.has(v.id) ? 'bg-indigo-50/40' : isOverridden ? 'bg-amber-50/20' : ''
                      }`}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedVarIds.has(v.id)}
                          onChange={() => toggleSelectRow(v.id)}
                          className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono font-medium text-gray-900">
                        {v.sku || `#${v.id}`}
                      </td>
                      <td className="px-3 py-2 text-gray-700 font-medium">
                        {v.color || <span className="text-gray-400">-</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-700 font-medium">
                        {v.size || <span className="text-gray-400">-</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">
                        {formatMoney(v.supplier_cost)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-medium text-gray-900">
                        {formatMoney(v.selling_price)}
                        <span className="block text-[10px] text-gray-400 font-sans capitalize truncate max-w-[110px]">
                          {v.source?.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={edit.override_type}
                          onChange={(e) => handleRowEditChange(v.id, 'override_type', e.target.value)}
                          className="px-2 py-1 border border-gray-300 rounded text-xs bg-white text-gray-800 font-medium"
                        >
                          <option value="product_rules">Use Product Pricing</option>
                          <option value="custom_markup">Custom Markup %</option>
                          <option value="fixed_price">Fixed Price £</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {edit.override_type === 'custom_markup' ? (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-500">+</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={edit.custom_markup_percent}
                              onChange={(e) =>
                                handleRowEditChange(v.id, 'custom_markup_percent', e.target.value)
                              }
                              placeholder="250"
                              className="w-20 px-2 py-1 border border-gray-300 rounded font-mono text-xs"
                            />
                            <span className="text-gray-500">%</span>
                          </div>
                        ) : edit.override_type === 'fixed_price' ? (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-500">£</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={edit.fixed_price}
                              onChange={(e) => handleRowEditChange(v.id, 'fixed_price', e.target.value)}
                              placeholder="14.99"
                              className="w-20 px-2 py-1 border border-gray-300 rounded font-mono text-xs"
                            />
                          </div>
                        ) : (
                          <span className="text-gray-400 italic text-[11px]">Inherits product rule</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700 text-sm">
                        {formatMoney(calculatedPrice)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {isOverridden && (
                            <button
                              type="button"
                              onClick={() => handleSaveSingleRow(v)}
                              disabled={isSaving}
                              className="px-2.5 py-1 bg-indigo-600 text-white text-[11px] font-bold rounded hover:bg-indigo-700 disabled:opacity-50"
                            >
                              {isSaving ? '...' : 'Save'}
                            </button>
                          )}
                          {v.override?.override_type && v.override.override_type !== 'product_rules' && (
                            <button
                              type="button"
                              onClick={() => handleResetSingleRow(v)}
                              disabled={isSaving}
                              className="px-2 py-1 text-[11px] text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded font-medium disabled:opacity-50"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Footer & Pagination ─────────────────────────────────────────── */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between text-xs">
          <div className="text-gray-600">
            Showing <strong>{Math.min(filteredVariations.length, (page - 1) * ITEMS_PER_PAGE + 1)}</strong> to{' '}
            <strong>{Math.min(filteredVariations.length, page * ITEMS_PER_PAGE)}</strong> of{' '}
            <strong>{filteredVariations.length}</strong> variations
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 bg-white border border-gray-300 rounded font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="font-semibold text-gray-700">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3 py-1.5 bg-white border border-gray-300 rounded font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-4 px-4 py-1.5 bg-indigo-600 text-white font-bold rounded hover:bg-indigo-700"
            >
              Done
            </button>
          </div>
        </div>
      </div>

      {/* ── Bulk Confirmation Dialog ──────────────────────────────────────── */}
      {showBulkConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-5 space-y-4">
            <h4 className="text-base font-bold text-gray-900">
              {bulkAction === 'reset' ? 'Reset Selected Variations?' : 'Apply Bulk Override?'}
            </h4>
            <p className="text-xs text-gray-600">
              {bulkAction === 'reset'
                ? `Reset ${selectedVarIds.size} selected variations to follow product/store pricing rules?`
                : bulkType === 'custom_markup'
                ? `Apply +${bulkValue}% markup to ${selectedVarIds.size} selected variations?`
                : `Apply fixed price of £${Number(bulkValue).toFixed(2)} to ${selectedVarIds.size} selected variations?`}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowBulkConfirm(false)}
                className="px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-semibold rounded hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeBulkAction}
                disabled={loading}
                className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded hover:bg-indigo-700"
              >
                {loading ? 'Applying...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
