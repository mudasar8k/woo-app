'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { validatePricingRules, round2 } from '@/app/lib/pricing'

export default function StorePriceRuleSettings({
  storeId,
  storeName,
  initialOverride = null,
  defaultPercent = null,
  initialEffective = null,
  initialIsOverride = false,
  initialPricingMode = 'legacy_markup',
  initialFallbackMarkup = null,
  initialRules = [],
}) {
  const router = useRouter()

  // ── Server-synced active state ─────────────────────────────────────────────
  const [activePricingMode, setActivePricingMode] = useState(initialPricingMode)
  const [activeOverride, setActiveOverride] = useState(initialOverride)
  const [activeFallback, setActiveFallback] = useState(initialFallbackMarkup)
  const [activeEffective, setActiveEffective] = useState(initialEffective)
  const [isOverride, setIsOverride] = useState(Boolean(initialIsOverride))

  // ── Category Pricing Rules state ──────────────────────────────────────────
  const [catRules, setCatRules] = useState([])
  const [availableCategories, setAvailableCategories] = useState([])
  const [catLoading, setCatLoading] = useState(true)
  const [catSaving, setCatSaving] = useState(false)
  const [catError, setCatError] = useState('')
  const [catSuccess, setCatSuccess] = useState('')
  const [newCatName, setNewCatName] = useState('')
  const [newCatMarkup, setNewCatMarkup] = useState('')
  // ── UI / Draft state ───────────────────────────────────────────────────────
  const [selectedMode, setSelectedMode] = useState(initialPricingMode)
  const [useLegacyOverride, setUseLegacyOverride] = useState(Boolean(initialIsOverride))
  const [legacyValue, setLegacyValue] = useState(
    initialOverride === null || initialOverride === undefined ? '' : String(initialOverride)
  )

  const [fallbackValue, setFallbackValue] = useState(
    initialFallbackMarkup === null || initialFallbackMarkup === undefined ? '' : String(initialFallbackMarkup)
  )

  const [rules, setRules] = useState(
    Array.isArray(initialRules) && initialRules.length > 0
      ? initialRules
      : [
          { min_cost: 0, max_cost: 5, markup_percent: 177, active: true },
          { min_cost: 5, max_cost: 10, markup_percent: 100, active: true },
          { min_cost: 10, max_cost: 20, markup_percent: 75, active: true },
          { min_cost: 20, max_cost: 50, markup_percent: 50, active: true },
          { min_cost: 50, max_cost: null, markup_percent: 35, active: true },
        ]
  )

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // ── Live Calculator State ──────────────────────────────────────────────────
  const [calcCost, setCalcCost] = useState('12.50')
  const [calcResult, setCalcResult] = useState(null)
  const [calcLoading, setCalcLoading] = useState(false)

  // ── Impact Preview Modal State ─────────────────────────────────────────────
  const [showPreviewModal, setShowPreviewModal] = useState(false)
  const [previewData, setPreviewData] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // ── Activation & Rollback Confirmation Modals ──────────────────────────────
  const [showActivationModal, setShowActivationModal] = useState(false)
  const [showRollbackModal, setShowRollbackModal] = useState(false)

  // Load existing rules from backend on mount
  useEffect(() => {
    async function loadConfigAndRules() {
      try {
        const [configRes, rulesRes] = await Promise.all([
          fetch(`/api/stores/${storeId}/pricing-config`),
          fetch(`/api/stores/${storeId}/pricing-rules`),
        ])
        if (configRes.ok) {
          const config = await configRes.json()
          setActivePricingMode(config.pricing_mode)
          setSelectedMode(config.pricing_mode)
          setActiveOverride(config.price_rule_percent)
          setLegacyValue(config.price_rule_percent !== null ? String(config.price_rule_percent) : '')
          setActiveFallback(config.fallback_markup_percent)
          setFallbackValue(config.fallback_markup_percent !== null ? String(config.fallback_markup_percent) : '')
          setActiveEffective(config.effective_price_rule_percent)
          setIsOverride(Boolean(config.is_override))
          setUseLegacyOverride(Boolean(config.is_override))
        }
        if (rulesRes.ok) {
          const rData = await rulesRes.json()
          if (Array.isArray(rData.rules) && rData.rules.length > 0) {
            setRules(rData.rules)
          }
        }
      } catch (err) {
        console.error('Error loading pricing data:', err)
      }
    }
    loadConfigAndRules()
  }, [storeId])

  // Run validation on current draft rules
  const validation = validatePricingRules(rules, {
    fallbackMarkup: fallbackValue === '' ? null : Number(fallbackValue),
    requireContinuous: selectedMode === 'range_rules',
  })

  // ── Rule Row Mutations (Draft state) ───────────────────────────────────────
  const handleAddRule = () => {
    setError('')
    setSuccess('')
    let nextMin = 0
    if (rules.length > 0) {
      const lastRule = rules[rules.length - 1]
      if (lastRule.max_cost === null) {
        setError('Cannot add a rule after an open-ended rule (with no upper limit).')
        return
      }
      nextMin = Number(lastRule.max_cost) || 0
    }
    setRules([...rules, { min_cost: nextMin, max_cost: nextMin + 10, markup_percent: 50, active: true }])
  }

  const handleUpdateRule = (index, field, value) => {
    setError('')
    setSuccess('')
    const updated = [...rules]
    if (field === 'max_cost' && (value === '' || value === null)) {
      updated[index].max_cost = null
    } else if (field === 'isOpenEnded') {
      updated[index].max_cost = value ? null : (Number(updated[index].min_cost) || 0) + 10
    } else {
      updated[index][field] = value === '' ? '' : Number(value)
    }
    setRules(updated)
  }

  const handleDeleteRule = (index) => {
    setError('')
    setSuccess('')
    setRules(rules.filter((_, i) => i !== index))
  }

  const handleMoveRule = (index, direction) => {
    setError('')
    setSuccess('')
    const target = index + direction
    if (target < 0 || target >= rules.length) return
    const updated = [...rules]
    const temp = updated[index]
    updated[index] = updated[target]
    updated[target] = temp
    setRules(updated)
  }

  // ── Live Calculator ────────────────────────────────────────────────────────
  const runCalculator = async (costVal) => {
    if (!costVal || isNaN(costVal)) return
    setCalcLoading(true)
    try {
      const res = await fetch(`/api/stores/${storeId}/pricing-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cost: Number(costVal),
          preview_mode: selectedMode,
          preview_rules: rules,
          preview_category_rules: catRules,
          preview_fallback: fallbackValue === '' ? null : Number(fallbackValue),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setCalcResult(data)
      }
    } catch (err) {
      console.error('Calculator preview error:', err)
    } finally {
      setCalcLoading(false)
    }
  }

  // ── Impact Preview ─────────────────────────────────────────────────────────
  const handleOpenImpactPreview = async () => {
    setShowPreviewModal(true)
    setPreviewLoading(true)
    try {
      const res = await fetch(`/api/stores/${storeId}/pricing-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview_sample: true,
          limit: 20,
          preview_rules: rules,
          preview_fallback: fallbackValue === '' ? null : Number(fallbackValue),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setPreviewData(data)
      } else {
        setError(data.error || 'Failed to load impact preview')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPreviewLoading(false)
    }
  }

  // ── Save Actions ───────────────────────────────────────────────────────────
  const handleSaveLegacy = async (e) => {
    e?.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch(`/api/stores/${storeId}/pricing-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pricing_mode: 'legacy_markup',
          price_rule_percent: useLegacyOverride ? (legacyValue === '' ? null : Number(legacyValue)) : null,
          fallback_markup_percent: fallbackValue === '' ? null : Number(fallbackValue),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save single markup')

      setActivePricingMode('legacy_markup')
      setSelectedMode('legacy_markup')
      setActiveEffective(data.effective_price_rule_percent)
      setIsOverride(Boolean(data.is_override))
      setSuccess('Single markup saved successfully.')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveRangeRules = async () => {
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      if (!validation.valid) {
        throw new Error(validation.errors.join(' '))
      }

      const res = await fetch(`/api/stores/${storeId}/pricing-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.details ? data.details.join(' ') : data.error || 'Failed to save pricing rules')
      }

      setRules(data.rules)
      setSuccess('Price range rules saved successfully in draft.')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmActivation = async () => {
    setShowActivationModal(false)
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const rulesRes = await fetch(`/api/stores/${storeId}/pricing-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      })
      const rulesData = await rulesRes.json()
      if (!rulesRes.ok) {
        throw new Error(rulesData.details ? rulesData.details.join(' ') : rulesData.error || 'Failed to save rules before activation')
      }

      const configRes = await fetch(`/api/stores/${storeId}/pricing-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pricing_mode: 'range_rules',
          fallback_markup_percent: fallbackValue === '' ? null : Number(fallbackValue),
          price_rule_percent: useLegacyOverride ? (legacyValue === '' ? null : Number(legacyValue)) : null,
        }),
      })
      const configData = await configRes.json()
      if (!configRes.ok) {
        throw new Error(configData.details ? configData.details.join(' ') : configData.error || 'Failed to activate tiered pricing')
      }

      setActivePricingMode('range_rules')
      setSelectedMode('range_rules')
      setActiveFallback(configData.fallback_markup_percent)
      setSuccess('Tiered Price Ranges are now ACTIVE for this store.')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmRollback = async () => {
    setShowRollbackModal(false)
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch(`/api/stores/${storeId}/pricing-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pricing_mode: 'legacy_markup',
          price_rule_percent: useLegacyOverride ? (legacyValue === '' ? null : Number(legacyValue)) : null,
          fallback_markup_percent: fallbackValue === '' ? null : Number(fallbackValue),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to revert pricing mode')

      setActivePricingMode('legacy_markup')
      setSelectedMode('legacy_markup')
      setActiveEffective(data.effective_price_rule_percent)
      setIsOverride(Boolean(data.is_override))
      setSuccess('Reverted to Single Markup (+177%). Tiered rules remain saved for future activation.')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const defaultLabel =
    defaultPercent === null || defaultPercent === undefined
      ? 'No default (sell = cost)'
      : `+${defaultPercent}%`

  return (
    <div className="bg-white shadow rounded-lg p-6 space-y-6 max-w-4xl">
      {/* ── Header & Active Status Banner ──────────────────────────────────── */}
      <div className="border-b border-gray-200 pb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Pricing Settings</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Store: <span className="font-semibold text-gray-700">{storeName}</span>
            </p>
          </div>
          <div>
            {activePricingMode === 'range_rules' ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
                Active: Tiered Price Ranges
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-300">
                <span className="h-2 w-2 rounded-full bg-blue-600" />
                Active: Single Markup ({activeEffective !== null ? `+${activeEffective}%` : 'Cost'})
              </span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded-md text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-400 text-emerald-800 px-4 py-3 rounded-md text-sm font-medium">
          {success}
        </div>
      )}

      {/* ── Mode Switcher Card ────────────────────────────────────────────── */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
        <label className="text-sm font-semibold text-gray-900 block">Select Pricing Mode</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label
            className={`flex items-start gap-3 p-3.5 rounded-md border cursor-pointer transition ${
              selectedMode === 'legacy_markup'
                ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              name="pricing_mode"
              value="legacy_markup"
              checked={selectedMode === 'legacy_markup'}
              onChange={() => {
                setSelectedMode('legacy_markup')
                setError('')
              }}
              className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
            />
            <div>
              <span className="block text-sm font-medium text-gray-900">Single Markup (%)</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Apply one uniform markup percentage across all catalog items (e.g. +177%).
              </span>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 p-3.5 rounded-md border cursor-pointer transition ${
              selectedMode === 'range_rules'
                ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
          >
            <input
              type="radio"
              name="pricing_mode"
              value="range_rules"
              checked={selectedMode === 'range_rules'}
              onChange={() => {
                setSelectedMode('range_rules')
                setError('')
              }}
              className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500"
            />
            <div>
              <span className="block text-sm font-medium text-gray-900">Tiered Price Ranges</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Configure unlimited price bands with distinct markup % based on supplier cost.
              </span>
            </div>
          </label>
        </div>

        {selectedMode !== activePricingMode && (
          <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center justify-between">
            <span>
              <strong>Draft Mode:</strong> You are viewing {selectedMode === 'range_rules' ? 'Tiered Ranges' : 'Single Markup'}. Live pricing remains{' '}
              <strong>{activePricingMode === 'range_rules' ? 'Tiered Ranges' : `Single Markup (+${activeEffective}%)`}</strong> until saved and activated.
            </span>
          </div>
        )}
      </div>

      {/* ── MODE A: Single Legacy Markup Section ───────────────────────────── */}
      {selectedMode === 'legacy_markup' && (
        <form onSubmit={handleSaveLegacy} className="space-y-4 pt-2">
          <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-1">
            <p>
              Super-admin global default: <span className="font-medium">{defaultLabel}</span>
            </p>
            <p>
              Currently effective:{' '}
              <span className="font-semibold text-indigo-700">
                {activeEffective === null || activeEffective === undefined
                  ? 'No markup (sell = cost)'
                  : `+${activeEffective}%`}
              </span>
              {isOverride ? ' (store override)' : ' (super-admin default)'}
            </p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useLegacyOverride}
              onChange={(e) => setUseLegacyOverride(e.target.checked)}
              disabled={loading}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Override default for this store</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                When unchecked, this store uses the super-admin default markup.
              </span>
            </span>
          </label>

          {useLegacyOverride && (
            <div>
              <label htmlFor="price_rule_percent" className="block text-sm font-medium text-gray-700 mb-1">
                Store markup (%)
              </label>
              <input
                type="number"
                step="0.01"
                id="price_rule_percent"
                value={legacyValue}
                onChange={(e) => setLegacyValue(e.target.value)}
                placeholder="e.g. 177"
                disabled={loading}
                className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Markup on cost (e.g. 177 → sell at cost × 2.77).
              </p>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {loading ? 'Saving...' : 'Save Single Markup'}
            </button>

            {activePricingMode === 'range_rules' && (
              <button
                type="button"
                onClick={() => setShowRollbackModal(true)}
                disabled={loading}
                className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 disabled:opacity-50 transition"
              >
                Revert Store to Single Markup
              </button>
            )}
          </div>
        </form>
      )}

      {/* ── MODE B: Tiered Price Ranges Builder ────────────────────────────── */}
      {selectedMode === 'range_rules' && (
        <div className="space-y-6 pt-2">
          {/* Validation Warnings / Error Banner */}
          {!validation.valid && (
            <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-md space-y-1">
              <p className="text-sm font-bold text-red-800">Please correct the following range issues:</p>
              <ul className="list-disc list-inside text-xs text-red-700 space-y-0.5">
                {validation.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Range Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Configured Price Ranges</h3>
                <p className="text-xs text-gray-500">
                  Ranges evaluate deterministically: lower boundary is exclusive (min &lt; cost &le; max), except £0 which is inclusive.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAddRule}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-md hover:bg-indigo-100 transition"
              >
                + Add Price Range
              </button>
            </div>

            <div className="overflow-x-auto border border-gray-200 rounded-lg shadow-sm">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-gray-700 text-xs font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3 text-left">From (£ Cost)</th>
                    <th className="px-4 py-3 text-left">To (£ Cost)</th>
                    <th className="px-4 py-3 text-left">Markup %</th>
                    <th className="px-4 py-3 text-left">Example (£10 Cost)</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {rules.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">
                        No pricing ranges configured. Click "+ Add Price Range" to create your first band.
                      </td>
                    </tr>
                  ) : (
                    rules.map((rule, idx) => {
                      const isOpenEnded = rule.max_cost === null || rule.max_cost === undefined || rule.max_cost === ''
                      const exampleCost = isOpenEnded ? (Number(rule.min_cost) || 0) + 10 : Number(rule.max_cost) || 10
                      const examplePrice = round2(exampleCost * (1 + (Number(rule.markup_percent) || 0) / 100))

                      return (
                        <tr key={idx} className="hover:bg-gray-50/80 transition">
                          {/* Min Cost */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <span className="text-gray-400 text-xs">£</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={rule.min_cost}
                                onChange={(e) => handleUpdateRule(idx, 'min_cost', e.target.value)}
                                className="w-24 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-indigo-500"
                              />
                            </div>
                          </td>

                          {/* Max Cost */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            {isOpenEnded ? (
                              <span className="inline-flex items-center px-2 py-1 rounded bg-gray-100 text-gray-700 text-xs font-medium">
                                No Limit (Open-Ended)
                              </span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <span className="text-gray-400 text-xs">£</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={rule.max_cost}
                                  onChange={(e) => handleUpdateRule(idx, 'max_cost', e.target.value)}
                                  className="w-24 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-indigo-500"
                                />
                              </div>
                            )}
                            <label className="flex items-center gap-1.5 mt-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isOpenEnded}
                                onChange={(e) => handleUpdateRule(idx, 'isOpenEnded', e.target.checked)}
                                className="h-3 w-3 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                              />
                              <span className="text-[10px] text-gray-500">No upper limit</span>
                            </label>
                          </td>

                          {/* Markup % */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <span className="text-gray-400 text-xs">+</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={rule.markup_percent}
                                onChange={(e) => handleUpdateRule(idx, 'markup_percent', e.target.value)}
                                className="w-20 px-2 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-indigo-500"
                              />
                              <span className="text-gray-400 text-xs">%</span>
                            </div>
                          </td>

                          {/* Example Calculation */}
                          <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-600 font-mono">
                            £{exampleCost.toFixed(2)} → <strong className="text-gray-900">£{examplePrice?.toFixed(2)}</strong>
                          </td>

                          {/* Actions */}
                          <td className="px-4 py-2.5 whitespace-nowrap text-right text-xs">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleMoveRule(idx, -1)}
                                disabled={idx === 0}
                                title="Move Up"
                                className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveRule(idx, 1)}
                                disabled={idx === rules.length - 1}
                                title="Move Down"
                                className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteRule(idx)}
                                title="Delete Range"
                                className="p-1 text-red-500 hover:text-red-700 ml-1"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Fallback Markup */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <label htmlFor="fallback_markup" className="block text-sm font-semibold text-gray-900">
                  Fallback Markup (%)
                </label>
                <p className="text-xs text-gray-500">
                  Applied when an item cost lands outside configured ranges (or in an uncovered gap).
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-500 text-sm">+</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  id="fallback_markup"
                  value={fallbackValue}
                  onChange={(e) => setFallbackValue(e.target.value)}
                  placeholder="e.g. 40"
                  className="w-28 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-1 focus:ring-indigo-500"
                />
                <span className="text-gray-500 text-sm">%</span>
              </div>
            </div>
          </div>

          {/* ── Live Calculator Box ────────────────────────────────────────── */}
          <div className="border border-indigo-100 bg-indigo-50/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-indigo-900 flex items-center gap-1.5">
                <span>🧮</span> Live Pricing Calculator
              </h4>
              <span className="text-[11px] text-indigo-600 font-medium">Test Draft Rules Instantly</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                <span className="text-xs font-semibold text-gray-700">Test Cost:</span>
                <span className="text-xs text-gray-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  value={calcCost}
                  onChange={(e) => {
                    setCalcCost(e.target.value)
                    runCalculator(e.target.value)
                  }}
                  placeholder="12.50"
                  className="w-28 px-2.5 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <button
                type="button"
                onClick={() => runCalculator(calcCost)}
                disabled={calcLoading}
                className="px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 transition"
              >
                {calcLoading ? 'Calculating...' : 'Calculate'}
              </button>

              {calcResult && (
                <div className="flex items-center gap-2 pl-2 text-xs text-indigo-950 font-mono">
                  <span>Markup: <strong>+{calcResult.applied_markup}%</strong></span>
                  <span>•</span>
                  <span>Selling Price: <strong className="text-indigo-700 text-sm">£{calcResult.selling_price?.toFixed(2)}</strong></span>
                  <span>({calcResult.source})</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Action Buttons ────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-200">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveRangeRules}
                disabled={loading || !validation.valid}
                className="px-4 py-2 bg-gray-800 text-white text-sm font-medium rounded-md hover:bg-gray-900 disabled:opacity-40 transition"
              >
                {loading ? 'Saving...' : 'Save Pricing Rules (Draft)'}
              </button>

              <button
                type="button"
                onClick={handleOpenImpactPreview}
                disabled={loading}
                className="px-4 py-2 bg-white text-indigo-700 border border-indigo-300 text-sm font-medium rounded-md hover:bg-indigo-50 transition"
              >
                Preview Price Impact (20 SKUs)
              </button>
            </div>

            <div>
              {activePricingMode === 'range_rules' ? (
                <button
                  type="button"
                  onClick={() => setShowRollbackModal(true)}
                  disabled={loading}
                  className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 transition"
                >
                  Revert to Single Markup (+177%)
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowActivationModal(true)}
                  disabled={loading || !validation.valid}
                  className="px-5 py-2 bg-emerald-600 text-white text-sm font-bold rounded-md hover:bg-emerald-700 disabled:opacity-40 shadow-sm transition"
                >
                  Activate Tiered Pricing
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── IMPACT PREVIEW MODAL ───────────────────────────────────────────── */}
      {showPreviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Price Impact Preview</h3>
                <p className="text-xs text-gray-500">
                  Read-only comparison of current active selling price vs proposed tiered price across representative products.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPreviewModal(false)}
                className="text-gray-400 hover:text-gray-700 text-lg font-bold p-1"
              >
                ✕
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 space-y-4">
              {previewLoading ? (
                <div className="py-12 text-center text-sm text-gray-500">
                  Calculating catalog impact...
                </div>
              ) : previewData?.items?.length > 0 ? (
                <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200 text-xs">
                    <thead className="bg-gray-50 text-gray-700 font-semibold uppercase">
                      <tr>
                        <th className="px-3 py-2.5 text-left">SKU / Item</th>
                        <th className="px-3 py-2.5 text-right">Supplier Cost</th>
                        <th className="px-3 py-2.5 text-right">Current Price</th>
                        <th className="px-3 py-2.5 text-right">Proposed Price</th>
                        <th className="px-3 py-2.5 text-right">Markup %</th>
                        <th className="px-3 py-2.5 text-right">Diff (£ / %)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {previewData.items.map((it, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-3 py-2">
                            <span className="font-bold text-gray-900">{it.sku}</span>
                            <span className="block text-gray-500 truncate max-w-xs">{it.name}</span>
                            {it.variation_attrs && (
                              <span className="text-[10px] text-indigo-600 font-medium">{it.variation_attrs}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-700">
                            £{it.supplier_cost?.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-600">
                            £{it.current_price?.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">
                            £{it.proposed_price?.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-600">
                            +{it.applied_markup}%
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            <span className={it.diff_amount > 0 ? 'text-emerald-700' : it.diff_amount < 0 ? 'text-rose-700' : 'text-gray-500'}>
                              {it.diff_amount > 0 ? `+£${it.diff_amount.toFixed(2)}` : `£${it.diff_amount.toFixed(2)}`}
                              {' '}({it.diff_percent > 0 ? `+${it.diff_percent}%` : `${it.diff_percent}%`})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-gray-500">
                  No sample products found to preview.
                </div>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 flex justify-end">
              <button
                type="button"
                onClick={() => setShowPreviewModal(false)}
                className="px-4 py-2 bg-gray-100 text-gray-800 text-xs font-semibold rounded hover:bg-gray-200 transition"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ACTIVATION CONFIRMATION MODAL ──────────────────────────────────── */}
      {showActivationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xl">
                ✓
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Activate Tiered Pricing?</h3>
                <p className="text-xs text-gray-500">Store: {storeName}</p>
              </div>
            </div>

            <p className="text-sm text-gray-600">
              Activating Tiered Pricing will change calculated selling prices for this store based on the {rules.length} configured price bands.
              Raw supplier costs remain unchanged.
            </p>

            <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-xs text-emerald-800 space-y-1">
              <p>• {rules.length} price ranges will take effect immediately.</p>
              <p>• Fallback markup: {fallbackValue ? `+${fallbackValue}%` : 'None (continuous ranges)'}</p>
              <p>• You can revert back to Single Markup (+177%) at any time.</p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowActivationModal(false)}
                className="px-4 py-2 bg-gray-100 text-gray-700 text-xs font-semibold rounded hover:bg-gray-200 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmActivation}
                disabled={loading}
                className="px-4 py-2 bg-emerald-600 text-white text-xs font-bold rounded hover:bg-emerald-700 transition"
              >
                {loading ? 'Activating...' : 'Confirm & Activate Pricing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ROLLBACK CONFIRMATION MODAL ────────────────────────────────────── */}
      {showRollbackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-xl">
                ↺
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">Revert to Single Markup?</h3>
                <p className="text-xs text-gray-500">Store: {storeName}</p>
              </div>
            </div>

            <p className="text-sm text-gray-600">
              This will restore Single Markup (+177%) across all catalog items for this store.
              Your configured tiered rules will be preserved in draft for future activation.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowRollbackModal(false)}
                className="px-4 py-2 bg-gray-100 text-gray-700 text-xs font-semibold rounded hover:bg-gray-200 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRollback}
                disabled={loading}
                className="px-4 py-2 bg-amber-600 text-white text-xs font-bold rounded hover:bg-amber-700 transition"
              >
                {loading ? 'Reverting...' : 'Confirm Reversion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
