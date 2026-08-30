'use client'

import { useState } from 'react'
import { Button } from '@/app/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/app/components/ui/card'

/**
 * Shows the store's export_api_key (used by the WordPress "WooApp
 * Connector" plugin to pull products from /api/export/*) and lets a
 * super admin regenerate it if it's ever leaked.
 */
export default function ExportApiKeyCard({ storeId, initialApiKey }) {
  const [apiKey, setApiKey] = useState(initialApiKey || '')
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy automatically - select and copy the key manually.')
    }
  }

  const handleRegenerate = async () => {
    if (!window.confirm('Regenerating will immediately invalidate the current key. The WordPress plugin will need the new key before it can sync again. Continue?')) {
      return
    }

    setIsRegenerating(true)
    setError(null)

    try {
      const response = await fetch(`/api/stores/${storeId}/export-key`, { method: 'POST' })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to regenerate key')
      }

      setApiKey(data.export_api_key)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsRegenerating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>WooApp Connector (WordPress plugin)</CardTitle>
        <CardDescription>
          Paste this store&apos;s API URL and key into the &quot;WooApp Connector&quot; settings
          screen in WordPress so it can pull approved products from WooApp.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">WooApp API Base URL</p>
          <code className="block rounded bg-gray-100 px-3 py-2 text-sm break-all">
            {typeof window !== 'undefined' ? window.location.origin : ''}
          </code>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Store ID</p>
          <code className="block rounded bg-gray-100 px-3 py-2 text-sm">{storeId}</code>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-1">Export API Key</p>
          <code className="block rounded bg-gray-100 px-3 py-2 text-sm break-all">
            {apiKey || '(none yet - click Regenerate)'}
          </code>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" onClick={handleCopy} disabled={!apiKey}>
            {copied ? 'Copied!' : 'Copy Key'}
          </Button>
          <Button type="button" variant="outline" onClick={handleRegenerate} disabled={isRegenerating}>
            {isRegenerating ? 'Regenerating...' : 'Regenerate Key'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
