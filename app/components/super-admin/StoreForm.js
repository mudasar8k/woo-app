'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { storeQueries } from '@/app/lib/api/query-functions'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { Label } from '@/app/components/ui/label'
import { Select } from '@/app/components/ui/select'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/app/components/ui/card'

export default function StoreForm({ store = null }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [formData, setFormData] = useState({
    name: store?.name || '',
    store_url: store?.store_url || '',
    consumer_key: store?.consumer_key || '',
    consumer_secret: store?.consumer_secret || '',
    status: store?.status || 'active',
    connection_method: store?.connection_method || 'api',
    price_rule_percent:
      store?.price_rule_percent === null || store?.price_rule_percent === undefined
        ? ''
        : String(store.price_rule_percent),
  })
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionResult, setConnectionResult] = useState(null)

  const mutation = useMutation({
    mutationFn: async (data) => {
      if (store) {
        return storeQueries.update({ id: store.id, ...data })
      }
      return storeQueries.create(data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stores'] })
      router.push('/super-admin/stores')
      router.refresh()
    },
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    mutation.mutate(formData)
  }

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    })
    // Clear connection result when credentials change
    if (['store_url', 'consumer_key', 'consumer_secret'].includes(e.target.name)) {
      setConnectionResult(null)
    }
  }

  const handleConnectionMethodChange = (method) => {
    setFormData({ ...formData, connection_method: method })
    setConnectionResult(null)
  }

  const isApiMethod = formData.connection_method === 'api'

  const handleTestConnection = async () => {
    if (!formData.store_url || !formData.consumer_key || !formData.consumer_secret) {
      setConnectionResult({
        success: false,
        error: 'Please fill in Store URL, Consumer Key, and Consumer Secret first',
      })
      return
    }

    setTestingConnection(true)
    setConnectionResult(null)

    try {
      const response = await fetch('/api/stores/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_url: formData.store_url,
          consumer_key: formData.consumer_key,
          consumer_secret: formData.consumer_secret,
        }),
      })

      const data = await response.json()
      setConnectionResult(data)
    } catch (error) {
      setConnectionResult({
        success: false,
        error: error.message || 'Failed to test connection',
      })
    } finally {
      setTestingConnection(false)
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{store ? 'Edit Store' : 'Add New Store'}</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {mutation.isError && (
            <div className="bg-destructive/15 text-destructive text-sm px-4 py-3 rounded-md border border-destructive/20">
              {mutation.error?.message || 'Failed to save store'}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">
              Store Name <span className="text-destructive">*</span>
            </Label>
            <Input
              type="text"
              id="name"
              name="name"
              required
              value={formData.name}
              onChange={handleChange}
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="store_url">
              Store URL <span className="text-destructive">*</span>
            </Label>
            <Input
              type="url"
              id="store_url"
              name="store_url"
              required
              value={formData.store_url}
              onChange={handleChange}
              placeholder="https://example.com"
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label>
              Connection Method <span className="text-destructive">*</span>
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleConnectionMethodChange('api')}
                disabled={mutation.isPending}
                className={`text-left rounded-md border px-4 py-3 transition-colors ${
                  isApiMethod ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-input'
                }`}
              >
                <div className="font-medium">REST API</div>
                <div className="text-sm text-muted-foreground mt-1">
                  WooApp connects to WooCommerce using a Consumer Key/Secret. Requires the store to be publicly reachable.
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleConnectionMethodChange('plugin')}
                disabled={mutation.isPending}
                className={`text-left rounded-md border px-4 py-3 transition-colors ${
                  !isApiMethod ? 'border-primary ring-1 ring-primary bg-primary/5' : 'border-input'
                }`}
              >
                <div className="font-medium">WordPress Plugin</div>
                <div className="text-sm text-muted-foreground mt-1">
                  Install the "WooApp Connector" plugin on the WooCommerce site; it pulls products from WooApp. No Consumer Key/Secret needed.
                </div>
              </button>
            </div>
          </div>

          {isApiMethod ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="consumer_key">
                  WooCommerce Consumer Key <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="text"
                  id="consumer_key"
                  name="consumer_key"
                  required
                  value={formData.consumer_key}
                  onChange={handleChange}
                  disabled={mutation.isPending}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="consumer_secret">
                  WooCommerce Consumer Secret <span className="text-destructive">*</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    id="consumer_secret"
                    name="consumer_secret"
                    required
                    value={formData.consumer_secret}
                    onChange={handleChange}
                    disabled={mutation.isPending || testingConnection}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestConnection}
                    disabled={mutation.isPending || testingConnection || !formData.store_url || !formData.consumer_key || !formData.consumer_secret}
                  >
                    {testingConnection ? 'Testing...' : 'Test Connect'}
                  </Button>
                </div>
              </div>

              {connectionResult && (
                <div className={`px-4 py-3 rounded-md border ${
                  connectionResult.success
                    ? 'bg-green-50 border-green-400 text-green-700'
                    : 'bg-red-50 border-red-400 text-red-700'
                }`}>
                  <div className="font-medium">
                    {connectionResult.success ? '✓ Connection Successful' : '✗ Connection Failed'}
                  </div>
                  <div className="text-sm mt-1">
                    {connectionResult.success
                      ? connectionResult.message || 'WooCommerce API credentials are valid.'
                      : connectionResult.error || 'Failed to connect to WooCommerce'}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-3 rounded-md border border-blue-200 bg-blue-50 text-blue-800 text-sm space-y-1">
              <p className="font-medium">No WooCommerce API keys needed for this method.</p>
              <p>
                {store
                  ? 'Scroll down for the Store ID and Export API Key to paste into the "WooApp Connector" plugin settings in WordPress.'
                  : 'After saving, open this store again to get the Store ID and Export API Key for the "WooApp Connector" plugin in WordPress.'}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="price_rule_percent">Store price override (%)</Label>
            <Input
              type="number"
              step="0.01"
              id="price_rule_percent"
              name="price_rule_percent"
              value={formData.price_rule_percent}
              onChange={handleChange}
              placeholder="Leave empty to use global default"
              disabled={mutation.isPending}
            />
            <p className="text-sm text-muted-foreground">
              Optional override for this store. Empty = use the super-admin default from Settings.
              Store admins can also change this on their Settings page. Markup is on Ralawise cost
              (e.g. 40 → sell at cost × 1.40).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">
              Status <span className="text-destructive">*</span>
            </Label>
            <Select
              id="status"
              name="status"
              value={formData.status}
              onChange={handleChange}
              disabled={mutation.isPending}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </div>
        </CardContent>

        <CardFooter className="flex justify-end space-x-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.back()}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving...' : store ? 'Update Store' : 'Create Store'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}


