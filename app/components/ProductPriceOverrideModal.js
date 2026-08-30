'use client'

import { useState, useEffect } from 'react'
import { formatMoney, toNumber, round2 } from '@/app/lib/pricing'

export default function ProductPriceOverrideModal({
  isOpen,
  onClose,
  storeId,
  product,
  onSaved,
}) {
  const [overrideType, setOverrideType] = useState('store_rules')
  const [customMarkup, setCustomMarkup] = useState('')
  const [fixedPrice, setFixedPrice] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetchingOverride, setFetchingOverride] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewData, setPreviewData] = useState(null)
  const [error, setError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmAction, setConfirmAction] = useState(null)

  // Fetch current override and preview when modal opens
  useEffect(() => {
    if (!isOpen || !product?.id) return

    setError('')
    setShowConfirm(false)
    setFetchingOverride(true)

    async function loadData() {
      try {
        const [overrideRes, previewRes] = await Promise.all([
          fetch(`/api/products/${product.id}/store-pricing?store_id=${storeId}`),
          fetch(`/api/stores/${storeId}/pricing-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: product.id }),
          }),
        ])

        if (overrideRes.ok) {
          const oData = await overrideRes.json()
          const ov = oData.override || {}
          setOverrideType(ov.override_type || 'store_rules')
          setCustomMarkup(ov.custom_markup_percent !== null && ov.custom_markup_percent !== undefined ? String(ov.custom_markup_percent) : '')
          setFixedPrice(ov.fixed_price !== null && ov.fixed_price !== undefined ? String(ov.fixed_price) : '')
        }

        if (previewRes.ok) {
          const pData = await previewRes.json()
          setPreviewData(pData)
        }
      } catch (err) {
        console.error('Error loading product pricing:', err)
        setError('Failed to load current pricing data')
      } finally {
        setFetchingOverride(false)
      }
    }

    loadData()
  }, [isOpen, product?.id, storeId])

  if (!isOpen || !product) return null

  const supplierCost = previewData?.product?.supplier_cost ?? Number(product.min_cost_price || product.price || 0)
  const currentSellingPrice = previewData?.product?.selling_price ?? null
  const currentSource = previewData?.product?.source ?? 'Store rules'

  // Calculate local proposed selling price for parent item
  let proposedSellingPrice = null
  if (overrideType === 'fixed_price') {
    proposedSellingPrice = fixedPrice !== '' && !isNaN(fixedPrice) ? Number(fixedPrice) : null
  } else if (overrideType === 'custom_markup') {
    const markupNum = customMarkup !== '' && !isNaN(customMarkup) ? Number(customMarkup) : null
    proposedSellingPrice = markupNum !== null ? round2(supplierCost * (1 + markupNum / 100)) : null
  } else {
    proposedSellingPrice = currentSellingPrice
  }

  const diffAmount = currentSellingPrice !== null && proposedSellingPrice !== null ? round2(proposedSellingPrice - currentSellingPrice) : 0
  const diffPercent = currentSellingPrice && currentSellingPrice > 0 ? round2(((proposedSellingPrice - currentSellingPrice) / currentSellingPrice) * 100) : 0

  const handleSaveClick = (e) => {
    e.preventDefault()
    setError('')

    if (overrideType === 'custom_markup') {
      const val = toNumber(customMarkup)
      if (val === null || val < 0) {
        setError('Custom markup percent must be a non-negative number.')
        return
      }
    } else if (overrideType === 'fixed_price') {
      const val = toNumber(fixedPrice)
      if (val === null || val < 0) {
        setError('Fixed price must be a non-negative number.')
        return
      }
    }

    setConfirmAction('save')
    setShowConfirm(true)
  }

  const handleResetClick = () => {
    setError('')
    setConfirmAction('reset')
    setShowConfirm(true)
  }

  const executeSave = async () => {
    setShowConfirm(false)
    setLoading(true)
    setError('')

    try {
      let bodyPayload = {
        store_id: storeId,
        override_type: overrideType,
      }

      if (overrideType === 'custom_markup') {
        bodyPayload.custom_markup_percent = Number(customMarkup)
      } else if (overrideType === 'fixed_price') {
        bodyPayload.fixed_price = Number(fixedPrice)
      }

      const res = await fetch(`/api/products/${product.id}/store-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save pricing override')
      }

      if (onSaved) onSaved(data.override)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const executeReset = async () => {
    setShowConfirm(false)
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`/api/products/${product.id}/store-pricing?store_id=${storeId}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset pricing override')
      }

      if (onSaved) onSaved({ override_type: 'store_rules', custom_markup_percent: null, fixed_price: null })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const variations = previewData?.variations || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col overflow-hidden">
        {/* ── Modal Header ───────────────────────────────────────────────── */}
        <div className="p-5 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-gray-900">Pricing Override</span>
              <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-gray-200 text-gray-800">
                {product.sku || 'No SKU'}
              </span>
              {product.store_status === 'removed' && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 text-rose-800">
                  Removed from Store
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600 truncate max-w-md mt-0.5">{product.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-lg font-bold p-1"
          >
            ✕
          </button>
        </div>

        {/* ── Modal Body ─────────────────────────────────────────────────── */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {error && (
            <div className="bg-red-50 border border-red-400 text-red-700 px-3.5 py-2.5 rounded-md text-xs font-medium">
              {error}
            </div>
          )}

          {fetchingOverride ? (
            <div className="py-8 text-center text-sm text-gray-500">
              Loading current pricing...
            </div>
          ) : (
            <>
              {/* Current Pricing Overview Banner */}
              <div className="grid grid-cols-3 gap-3 p-3.5 rounded-lg bg-gray-50 border border-gray-200 text-xs">
                <div>
                  <span className="text-gray-500 block">Supplier Cost</span>
                  <span className="font-mono font-bold text-gray-900 text-sm">
                    {formatMoney(supplierCost)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block">Current Selling Price</span>
                  <span className="font-mono font-bold text-indigo-700 text-sm">
                    {currentSellingPrice !== null ? formatMoney(currentSellingPrice) : '-'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block">Current Source</span>
                  <span className="font-medium text-gray-800 capitalize truncate block">
                    {currentSource.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>

              {/* Pricing Priority Hierarchy Notice */}
              <div className="text-[11px] text-gray-500 bg-indigo-50/60 border border-indigo-100 rounded-md p-2 flex items-center justify-between">
                <span>
                  <strong>Priority Engine:</strong> Fixed Price &gt; Custom Markup &gt; Store Tiered Rules &gt; Store Default
                </span>
              </div>

              {/* Override Option Radio Cards */}
              <div className="space-y-3">
                <label className="text-xs font-bold text-gray-900 uppercase tracking-wider block">
                  Select Override Strategy
                </label>

                {/* Option 1: Use Store Pricing */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    overrideType === 'store_rules'
                      ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_override_type"
                    value="store_rules"
                    checked={overrideType === 'store_rules'}
                    onChange={() => setOverrideType('store_rules')}
                    className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="block text-sm font-semibold text-gray-900">Use Store Pricing (Default)</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Follows the store's active pricing configuration (Tiered ranges or Single markup).
                    </span>
                  </div>
                </label>

                {/* Option 2: Custom Markup % */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    overrideType === 'custom_markup'
                      ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_override_type"
                    value="custom_markup"
                    checked={overrideType === 'custom_markup'}
                    onChange={() => setOverrideType('custom_markup')}
                    className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div className="flex-1">
                    <span className="block text-sm font-semibold text-gray-900">Custom Markup (%)</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Applies a custom markup % independently to each variation's supplier cost.
                    </span>

                    {overrideType === 'custom_markup' && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-700">Markup:</span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-400">+</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={customMarkup}
                            onChange={(e) => setCustomMarkup(e.target.value)}
                            placeholder="e.g. 80"
                            className="w-24 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500"
                          />
                          <span className="text-xs text-gray-400">%</span>
                        </div>
                        {proposedSellingPrice !== null && (
                          <span className="text-xs text-gray-600 ml-2 font-mono">
                            → Sells at: <strong className="text-indigo-700">{formatMoney(proposedSellingPrice)}</strong>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </label>

                {/* Option 3: Fixed Selling Price */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    overrideType === 'fixed_price'
                      ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_override_type"
                    value="fixed_price"
                    checked={overrideType === 'fixed_price'}
                    onChange={() => setOverrideType('fixed_price')}
                    className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div className="flex-1">
                    <span className="block text-sm font-semibold text-gray-900">Fixed Selling Price (£)</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Fixed price applies equally to all variations of this product.
                    </span>

                    {overrideType === 'fixed_price' && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-700">Selling Price:</span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-400">£</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={fixedPrice}
                            onChange={(e) => setFixedPrice(e.target.value)}
                            placeholder="e.g. 25.00"
                            className="w-24 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <span className="text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                          Applies to all variations
                        </span>
                      </div>
                    )}
                  </div>
                </label>
              </div>

              {/* Price Impact Summary */}
              {proposedSellingPrice !== null && (
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between text-xs">
                  <div>
                    <span className="text-gray-500">Proposed Parent Price: </span>
                    <strong className="font-mono text-gray-900 text-sm">{formatMoney(proposedSellingPrice)}</strong>
                  </div>
                  <div className="font-mono font-semibold">
                    <span className={diffAmount > 0 ? 'text-emerald-700' : diffAmount < 0 ? 'text-rose-700' : 'text-gray-500'}>
                      {diffAmount > 0 ? `+£${diffAmount.toFixed(2)}` : `£${diffAmount.toFixed(2)}`}
                      {' '}({diffPercent > 0 ? `+${diffPercent}%` : `${diffPercent}%`})
                    </span>
                  </div>
                </div>
              )}

              {/* Variations Breakdown Table (if product has variations) */}
              {variations.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-700">
                      Variations Impact Preview ({variations.length})
                    </span>
                    <span className="text-[10px] text-gray-500">
                      {overrideType === 'fixed_price'
                        ? 'All variations use fixed price'
                        : overrideType === 'custom_markup'
                        ? 'Markup applied per variation cost'
                        : 'Store rules applied per variation'}
                    </span>
                  </div>

                  <div className="border border-gray-200 rounded-lg overflow-hidden max-h-40 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-xs">
                      <thead className="bg-gray-50 text-gray-600 font-medium">
                        <tr>
                          <th className="px-3 py-1.5 text-left">Variation / SKU</th>
                          <th className="px-3 py-1.5 text-right">Cost</th>
                          <th className="px-3 py-1.5 text-right">Proposed Price</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {variations.slice(0, 15).map((v, i) => {
                          let vPrice = v.selling_price
                          if (overrideType === 'fixed_price' && fixedPrice !== '') {
                            vPrice = Number(fixedPrice)
                          } else if (overrideType === 'custom_markup' && customMarkup !== '') {
                            vPrice = round2(v.supplier_cost * (1 + Number(customMarkup) / 100))
                          }
                          return (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="px-3 py-1 font-mono text-gray-700">
                                {v.sku || `Variation #${v.id}`}
                                {v.color || v.size ? (
                                  <span className="text-[10px] text-gray-400 ml-1">
                                    ({[v.color, v.size].filter(Boolean).join('/')})
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-1 text-right font-mono text-gray-600">
                                {formatMoney(v.supplier_cost)}
                              </td>
                              <td className="px-3 py-1 text-right font-mono font-bold text-indigo-700">
                                {formatMoney(vPrice)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {variations.length > 15 && (
                    <p className="text-[10px] text-gray-400 text-right">
                      Showing first 15 of {variations.length} variations
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Modal Footer / Actions ─────────────────────────────────────── */}
        <div className="p-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div>
            {previewData?.product?.override?.override_type !== 'store_rules' && (
              <button
                type="button"
                onClick={handleResetClick}
                disabled={loading || fetchingOverride}
                className="px-3 py-1.5 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded hover:bg-amber-100 transition disabled:opacity-50"
              >
                Reset to Store Pricing
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 text-xs font-semibold rounded-md hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={loading || fetchingOverride}
              className="px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 transition disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Override'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Save / Reset Confirmation Modal ────────────────────────────────── */}
      {showConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-5 space-y-4">
            <h4 className="text-base font-bold text-gray-900">
              {confirmAction === 'reset' ? 'Reset Pricing Override?' : 'Save Pricing Override?'}
            </h4>
            <p className="text-xs text-gray-600">
              {confirmAction === 'reset'
                ? `Reset ${product.sku || product.name} to follow the store's default pricing configuration?`
                : overrideType === 'custom_markup'
                ? `Apply +${customMarkup}% custom markup to ${product.sku || product.name}? Each variation will be marked up individually.`
                : overrideType === 'fixed_price'
                ? `Set ${product.sku || product.name} to a fixed price of £${Number(fixedPrice).toFixed(2)}? All variations will use this price.`
                : `Apply store default pricing to ${product.sku || product.name}?`}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-semibold rounded hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAction === 'reset' ? executeReset : executeSave}
                disabled={loading}
                className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded hover:bg-indigo-700"
              >
                {loading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
