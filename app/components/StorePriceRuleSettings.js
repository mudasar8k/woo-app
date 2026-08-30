'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function StorePriceRuleSettings({
  storeId,
  storeName,
  initialOverride = null,
  defaultPercent = null,
  initialEffective = null,
  initialIsOverride = false,
}) {
  const router = useRouter()
  const [useOverride, setUseOverride] = useState(Boolean(initialIsOverride))
  const [value, setValue] = useState(
    initialOverride === null || initialOverride === undefined ? '' : String(initialOverride)
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [effective, setEffective] = useState(initialEffective)
  const [isOverride, setIsOverride] = useState(Boolean(initialIsOverride))

  const defaultLabel =
    defaultPercent === null || defaultPercent === undefined
      ? 'No default (sell = cost)'
      : `+${defaultPercent}%`

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      if (useOverride && value === '') {
        setError('Enter a markup percent, or uncheck override to use the default.')
        setLoading(false)
        return
      }

      const response = await fetch(`/api/stores/${storeId}/price-rule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_rule_percent: useOverride ? (value === '' ? null : value) : null,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save price rule')
      }

      setIsOverride(Boolean(data.is_override))
      setUseOverride(Boolean(data.is_override))
      setEffective(data.effective_price_rule_percent)
      setValue(
        data.price_rule_percent === null || data.price_rule_percent === undefined
          ? ''
          : String(data.price_rule_percent)
      )
      setSuccess('Price rule saved.')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-5 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Pricing</h2>
        <p className="text-sm text-gray-500 mt-1">
          Store: <span className="font-medium text-gray-700">{storeName}</span>
        </p>
      </div>

      <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 space-y-1">
        <p>
          Super-admin default: <span className="font-medium">{defaultLabel}</span>
        </p>
        <p>
          Currently applying:{' '}
          <span className="font-medium text-indigo-700">
            {effective === null || effective === undefined
              ? 'No markup (sell = cost)'
              : `+${effective}%`}
          </span>
          {isOverride ? ' (store override)' : ' (default)'}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded text-sm">
          {success}
        </div>
      )}

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={useOverride}
          onChange={(e) => setUseOverride(e.target.checked)}
          disabled={loading}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span>
          <span className="block text-sm font-medium text-gray-900">Override default for this store</span>
          <span className="block text-xs text-gray-500 mt-0.5">
            When unchecked, this store uses the super-admin default.
          </span>
        </span>
      </label>

      {useOverride && (
        <div>
          <label htmlFor="price_rule_percent" className="block text-sm font-medium text-gray-700 mb-1">
            Store markup (%)
          </label>
          <input
            type="number"
            step="0.01"
            id="price_rule_percent"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 40"
            disabled={loading}
            className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Markup on cost (e.g. 40 → sell at cost × 1.40).
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
      >
        {loading ? 'Saving...' : 'Save pricing'}
      </button>
    </form>
  )
}
