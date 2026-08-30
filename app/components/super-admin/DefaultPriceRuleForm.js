'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function DefaultPriceRuleForm({ initialPercent = null }) {
  const router = useRouter()
  const [value, setValue] = useState(
    initialPercent === null || initialPercent === undefined ? '' : String(initialPercent)
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const response = await fetch('/api/settings/price-rule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_price_rule_percent: value === '' ? null : value,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save default price rule')
      }
      setSuccess('Default price rule saved.')
      setValue(
        data.default_price_rule_percent === null || data.default_price_rule_percent === undefined
          ? ''
          : String(data.default_price_rule_percent)
      )
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-4 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Default price rule</h2>
        <p className="text-sm text-gray-500 mt-1">
          Applied to every store unless that store sets its own override. Markup is on Ralawise/CSV
          cost (e.g. 40 → sell at cost × 1.40).
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

      <div>
        <label htmlFor="default_price_rule_percent" className="block text-sm font-medium text-gray-700 mb-1">
          Default markup (%)
        </label>
        <input
          type="number"
          step="0.01"
          id="default_price_rule_percent"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 40"
          disabled={loading}
          className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <p className="text-xs text-gray-500 mt-1">Leave empty for no default markup (sell = cost).</p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
      >
        {loading ? 'Saving...' : 'Save default'}
      </button>
    </form>
  )
}
