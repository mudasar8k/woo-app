'use client'

import { useState, useEffect } from 'react'
import VariationPriceOverrideModal from '@/app/components/VariationPriceOverrideModal'
import { useRouter } from 'next/navigation'
import { formatMoney, toNumber, round2 } from '@/app/lib/pricing'

export default function ProductPriceOverrideCard({
  storeId,
  productId,
  product,
  variations = [],
}) {
  const router = useRouter()
  const [overrideType, setOverrideType] = useState('store_rules')
  const [customMarkup, setCustomMarkup] = useState('')
  const [fixedPrice, setFixedPrice] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [previewData, setPreviewData] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [confirmAction, setConfirmAction] = useState(null)
  const [showVariationModal, setShowVariationModal] = useState(false)

  useEffect(() => {
    async function loadData() {
      setFetching(true)
      try {
        const [overrideRes, previewRes] = await Promise.all([
          fetch(`/api/products/${productId}/store-pricing?store_id=${storeId}`),
          fetch(`/api/stores/${storeId}/pricing-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: productId }),
          }),
        ])

        if (overrideRes.ok) {
          const oData = await overrideRes.json().catch(() => ({}))
          const ov = oData.override || {}
          setOverrideType(ov.override_type || 'store_rules')
          setCustomMarkup(
            ov.custom_markup_percent !== null && ov.custom_markup_percent !== undefined
              ? String(ov.custom_markup_percent)
              : ''
          )
          setFixedPrice(
            ov.fixed_price !== null && ov.fixed_price !== undefined
              ? String(ov.fixed_price)
              : ''
          )
        }

        if (previewRes.ok) {
          const pData = await previewRes.json().catch(() => ({}))
          setPreviewData(pData)
        }
      } catch (err) {
        console.error('Error loading product pricing card data:', err)
      } finally {
        setFetching(false)
      }
    }

    loadData()
  }, [productId, storeId])

  const supplierCost =
    previewData?.product?.supplier_cost !== null && previewData?.product?.supplier_cost !== undefined
      ? Number(previewData.product.supplier_cost)
      : Number(product?.min_cost_price || product?.price || 0)

  const currentSellingPrice =
    previewData?.product?.selling_price !== null && previewData?.product?.selling_price !== undefined
      ? Number(previewData.product.selling_price)
      : null

  const currentSource = previewData?.product?.source || 'Store rules'
  const pricingMode = previewData?.pricing_mode || 'legacy_markup'

  let proposedSellingPrice = null
  if (overrideType === 'fixed_price') {
    proposedSellingPrice = fixedPrice !== '' && !isNaN(fixedPrice) ? Number(fixedPrice) : null
  } else if (overrideType === 'custom_markup') {
    const markupNum = customMarkup !== '' && !isNaN(customMarkup) ? Number(customMarkup) : null
    proposedSellingPrice = markupNum !== null && !isNaN(supplierCost) ? round2(supplierCost * (1 + markupNum / 100)) : null
  } else {
    proposedSellingPrice = currentSellingPrice
  }

  const diffAmount =
    currentSellingPrice !== null && proposedSellingPrice !== null && !isNaN(currentSellingPrice) && !isNaN(proposedSellingPrice)
      ? round2(proposedSellingPrice - currentSellingPrice)
      : 0

  const diffPercent =
    currentSellingPrice && currentSellingPrice > 0 && proposedSellingPrice !== null && !isNaN(proposedSellingPrice)
      ? round2(((proposedSellingPrice - currentSellingPrice) / currentSellingPrice) * 100)
      : 0

  const handleSaveClick = (e) => {
    e.preventDefault()
    setError('')
    setSuccess('')

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
    setSuccess('')
    setConfirmAction('reset')
    setShowConfirm(true)
  }

  const executeSave = async () => {
    setShowConfirm(false)
    setLoading(true)
    setError('')
    setSuccess('')

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

      const res = await fetch(`/api/products/${productId}/store-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save pricing override')
      }

      setSuccess('Pricing override saved successfully.')
      router.refresh()
    } catch (err) {
      setError(err.message || 'Failed to save pricing override')
    } finally {
      setLoading(false)
    }
  }

  const executeReset = async () => {
    setShowConfirm(false)
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const res = await fetch(`/api/products/${productId}/store-pricing?store_id=${storeId}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset pricing override')
      }

      setOverrideType('store_rules')
      setCustomMarkup('')
      setFixedPrice('')
      setSuccess('Pricing override removed. Product now follows store rules.')
      router.refresh()
    } catch (err) {
      setError(err.message || 'Failed to reset pricing override')
    } finally {
      setLoading(false)
    }
  }

  const varsList = previewData?.variations || variations || []

  return (
    <div className="bg-white shadow rounded-lg p-6 space-y-6 mt-6 border border-gray-100">
      {/* ── Card Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-gray-200 gap-2">
        <div>
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <span>🏷️</span> Store Pricing &amp; Overrides
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Configure store-specific pricing for this product.
          </p>
        </div>
        <div>
          {overrideType === 'custom_markup' ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-200">
              Override: Custom +{customMarkup}%
            </span>
          ) : overrideType === 'fixed_price' ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
              Override: Fixed £{Number(fixedPrice || 0).toFixed(2)}
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
              Active: Store Default Rules ({pricingMode === 'range_rules' ? 'Tiered' : 'Single Markup'})
            </span>
          )}
        </div>
      </div>

      {/* ── Feedback Banners ────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded-md text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-400 text-emerald-800 px-4 py-3 rounded-md text-sm">
          {success}
        </div>
      )}

      {/* ── Current Price Overview ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-lg bg-gray-50 border border-gray-200 text-sm">
        <div>
          <span className="text-gray-500 text-xs block">Supplier Cost</span>
          <span className="font-mono font-bold text-gray-900 text-base">
            {formatMoney(supplierCost)}
          </span>
        </div>
        <div>
          <span className="text-gray-500 text-xs block">Current Selling Price</span>
          <span className="font-mono font-bold text-indigo-700 text-base">
            {currentSellingPrice !== null ? formatMoney(currentSellingPrice) : '-'}
          </span>
        </div>
        <div>
          <span className="text-gray-500 text-xs block">Current Pricing Source</span>
          <span className="font-medium text-gray-800 capitalize truncate block text-sm">
            {String(currentSource).replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* ── Strategy Selector ───────────────────────────────────────────── */}
      <div className="space-y-4">
        <label className="text-xs font-bold text-gray-900 uppercase tracking-wider block">
          Override Strategy
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Store Rules */}
          <label
            className={`p-4 rounded-lg border cursor-pointer transition flex flex-col justify-between ${
              overrideType === 'store_rules'
                ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="card_override_type"
                  value="store_rules"
                  checked={overrideType === 'store_rules'}
                  onChange={() => setOverrideType('store_rules')}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="font-bold text-gray-900 text-sm">Store Rules</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Standard pricing rule from store configuration.
              </p>
            </div>
          </label>

          {/* Custom Markup */}
          <label
            className={`p-4 rounded-lg border cursor-pointer transition flex flex-col justify-between ${
              overrideType === 'custom_markup'
                ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="card_override_type"
                  value="custom_markup"
                  checked={overrideType === 'custom_markup'}
                  onChange={() => setOverrideType('custom_markup')}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="font-bold text-gray-900 text-sm">Custom Markup %</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Apply a custom markup % independently to each variation cost.
              </p>
            </div>
            {overrideType === 'custom_markup' && (
              <div className="mt-3 flex items-center gap-1">
                <span className="text-xs text-gray-400">+</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={customMarkup}
                  onChange={(e) => setCustomMarkup(e.target.value)}
                  placeholder="80"
                  className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-400">%</span>
              </div>
            )}
          </label>

          {/* Fixed Price */}
          <label
            className={`p-4 rounded-lg border cursor-pointer transition flex flex-col justify-between ${
              overrideType === 'fixed_price'
                ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="card_override_type"
                  value="fixed_price"
                  checked={overrideType === 'fixed_price'}
                  onChange={() => setOverrideType('fixed_price')}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="font-bold text-gray-900 text-sm">Fixed Price (£)</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Set a single fixed selling price across all variations.
              </p>
            </div>
            {overrideType === 'fixed_price' && (
              <div className="mt-3 flex items-center gap-1">
                <span className="text-xs text-gray-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fixedPrice}
                  onChange={(e) => setFixedPrice(e.target.value)}
                  placeholder="25.00"
                  className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            )}
          </label>
        </div>
      </div>

      {/* ── Impact Preview ──────────────────────────────────────────────── */}
      {proposedSellingPrice !== null && (
        <div className="p-4 bg-indigo-50/60 border border-indigo-100 rounded-lg flex items-center justify-between text-xs">
          <div>
            <span className="text-gray-600">Proposed Parent Price: </span>
            <strong className="font-mono text-gray-900 text-base ml-1">
              {formatMoney(proposedSellingPrice)}
            </strong>
          </div>
          <div className="font-mono font-semibold">
            <span className={diffAmount > 0 ? 'text-emerald-700' : diffAmount < 0 ? 'text-rose-700' : 'text-gray-500'}>
              {diffAmount > 0 ? `+£${Number(diffAmount).toFixed(2)}` : `£${Number(diffAmount).toFixed(2)}`}
              {' '}({diffPercent > 0 ? `+${diffPercent}%` : `${diffPercent}%`})
            </span>
          </div>
        </div>
      )}

      {/* ── Variations Impact Preview ───────────────────────────────────── */}
      {varsList.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-700">
              Variations Impact Preview ({varsList.length})
            </span>
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200 text-xs">
              <thead className="bg-gray-50 text-gray-600 font-medium">
                <tr>
                  <th className="px-3 py-2 text-left">Variation / SKU</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Proposed Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {varsList.slice(0, 10).map((v, i) => {
                  let vPrice = v.selling_price
                  if (overrideType === 'fixed_price' && fixedPrice !== '') {
                    vPrice = Number(fixedPrice)
                  } else if (overrideType === 'custom_markup' && customMarkup !== '') {
                    vPrice = round2(v.supplier_cost * (1 + Number(customMarkup) / 100))
                  }
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-mono text-gray-700">
                        {v.sku || `Variation #${v.id}`}
                        {v.color || v.size ? (
                          <span className="text-[10px] text-gray-400 ml-1">
                            ({[v.color, v.size].filter(Boolean).join('/')})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                        {formatMoney(v.supplier_cost)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold text-indigo-700">
                        {formatMoney(vPrice)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {varsList.length > 10 && (
            <p className="text-[10px] text-gray-400 text-right">
              Showing first 10 of {varsList.length} variations
            </p>
          )}
          <div className="pt-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setShowVariationModal(true)}
              className="px-3 py-1.5 text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md hover:bg-indigo-100 transition flex items-center gap-1.5 shadow-sm"
            >
              <span>⚡</span> Manage Variation Overrides ({varsList.length})
            </button>
          </div>
        </div>
      )}

      {/* ── Action Buttons ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-200">
        <div>
          {overrideType !== 'store_rules' && (
            <button
              type="button"
              onClick={handleResetClick}
              disabled={loading || fetching}
              className="px-4 py-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 transition disabled:opacity-50"
            >
              Reset to Store Pricing
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleSaveClick}
          disabled={loading || fetching}
          className="px-5 py-2 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 transition disabled:opacity-50 shadow-sm"
        >
          {loading ? 'Saving...' : 'Save Override'}
        </button>
      </div>

      {/* ── Variation-Level Override Modal ───────────────────────────────── */}
      {showVariationModal && (
        <VariationPriceOverrideModal
          isOpen={showVariationModal}
          onClose={() => setShowVariationModal(false)}
          storeId={storeId}
          productId={productId}
          product={product}
          onSaved={() => router.refresh()}
        />
      )}

      {/* ── Confirmation Modal ─────────────────────────────────────────── */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-5 space-y-4">
            <h4 className="text-base font-bold text-gray-900">
              {confirmAction === 'reset' ? 'Reset Pricing Override?' : 'Save Pricing Override?'}
            </h4>
            <p className="text-xs text-gray-600">
              {confirmAction === 'reset'
                ? `Reset ${product?.sku || product?.name || 'this product'} to follow the store's default pricing configuration?`
                : overrideType === 'custom_markup'
                ? `Apply +${customMarkup}% custom markup to ${product?.sku || product?.name || 'this product'}? Each variation will be marked up individually.`
                : overrideType === 'fixed_price'
                ? `Set ${product?.sku || product?.name || 'this product'} to a fixed price of £${Number(fixedPrice || 0).toFixed(2)}? All variations will use this price.`
                : `Apply store default pricing to ${product?.sku || product?.name || 'this product'}?`}
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
