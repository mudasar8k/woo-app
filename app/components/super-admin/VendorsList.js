'use client'

import Link from 'next/link'
import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { vendorQueries } from '@/app/lib/api/query-functions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/app/components/ui/table'
import { Button } from '@/app/components/ui/button'
import { Badge } from '@/app/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card'
import { Package, Edit, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '@/app/lib/format-date'

export default function VendorsList({ vendors }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [expandedVendorId, setExpandedVendorId] = useState(null)
  const [vendorStores, setVendorStores] = useState({})
  const [availableStores, setAvailableStores] = useState([])
  const [storesError, setStoresError] = useState('')

  const deleteMutation = useMutation({
    mutationFn: vendorQueries.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendors'] })
      router.refresh()
    },
  })

  const formatDate = formatDateTime

  const loadAvailableStores = async () => {
    if (availableStores.length > 0) return
    const response = await fetch('/api/stores')
    if (!response.ok) {
      throw new Error('Failed to fetch stores')
    }
    setAvailableStores(await response.json())
  }

  const loadVendorStores = async (vendorId) => {
    if (vendorStores[vendorId]) return
    const response = await fetch(`/api/vendors/${vendorId}/stores`)
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to fetch vendor stores')
    }
    const stores = await response.json()
    setVendorStores((prev) => ({ ...prev, [vendorId]: stores }))
  }

  const assignStoreToVendor = async (vendorId, storeId) => {
    const response = await fetch(`/api/vendors/${vendorId}/stores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to assign store')
    }
    await loadVendorStores(vendorId)
  }

  const removeStoreFromVendor = async (vendorId, storeId) => {
    if (!confirm('Remove this vendor from the store?')) return
    const response = await fetch(`/api/vendors/${vendorId}/stores/${storeId}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to remove store')
    }
    await loadVendorStores(vendorId)
  }

  const handleManageStoresToggle = async (vendorId) => {
    setStoresError('')
    if (expandedVendorId === vendorId) {
      setExpandedVendorId(null)
      return
    }
    setExpandedVendorId(vendorId)
    try {
      await Promise.all([loadVendorStores(vendorId), loadAvailableStores()])
    } catch (err) {
      setStoresError(err.message || 'Failed to load vendor stores')
    }
  }

  const getStatusBadge = (status) => {
    const variants = {
      active: 'success',
      inactive: 'secondary',
    }
    return (
      <Badge variant={variants[status] || 'secondary'}>
        {status}
      </Badge>
    )
  }

  const handleDelete = (id, name) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      deleteMutation.mutate(id)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center space-x-2">
              <Package className="h-5 w-5" />
              <span>Vendors</span>
            </CardTitle>
            <CardDescription>
              Manage your vendors
            </CardDescription>
          </div>
          <Button asChild>
            <Link href="/super-admin/vendors/new">
              Add New Vendor
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {vendors.length === 0 ? (
          <div className="text-center py-12">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No vendors found. Create your first vendor to get started.</p>
            <Button asChild className="mt-4">
              <Link href="/super-admin/vendors/new">Add New Vendor</Link>
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Contact Info</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((vendor) => (
                <React.Fragment key={vendor.id}>
                  <TableRow>
                    <TableCell className="font-medium">{vendor.name}</TableCell>
                    <TableCell>{vendor.email || '-'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {vendor.contact_info || '-'}
                    </TableCell>
                    <TableCell>{getStatusBadge(vendor.status)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(vendor.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleManageStoresToggle(vendor.id)}
                        >
                          {expandedVendorId === vendor.id ? 'Hide' : 'Manage'} Stores
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                        >
                          <Link href={`/super-admin/vendors/${vendor.id}`}>
                            <Edit className="h-4 w-4 mr-1" />
                            Edit
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(vendor.id, vendor.name)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 mr-1 text-destructive" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedVendorId === vendor.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-gray-50">
                        {storesError ? (
                          <div className="text-sm text-red-700 p-4">{storesError}</div>
                        ) : (
                          <div className="p-4 space-y-4">
                            <div>
                              <div className="text-sm font-medium text-gray-900 mb-2">Assigned stores</div>
                              {(vendorStores[vendor.id] || []).length > 0 ? (
                                <ul className="space-y-2">
                                  {vendorStores[vendor.id].map((store) => (
                                    <li key={store.id} className="flex items-center justify-between">
                                      <span className="text-sm text-gray-700">{store.name}</span>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => removeStoreFromVendor(vendor.id, store.id)}
                                      >
                                        Remove
                                      </Button>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="text-sm text-gray-500">No stores assigned.</div>
                              )}
                            </div>
                            <div>
                              <div className="text-sm font-medium text-gray-900 mb-2">Assign store</div>
                              <select
                                onChange={async (e) => {
                                  const value = e.target.value
                                  if (!value) return
                                  setStoresError('')
                                  try {
                                    await assignStoreToVendor(vendor.id, value)
                                    e.target.value = ''
                                  } catch (err) {
                                    setStoresError(err.message || 'Failed to assign store')
                                  }
                                }}
                                className="block w-full max-w-md rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                                defaultValue=""
                              >
                                <option value="">Select a store...</option>
                                {availableStores
                                  .filter(
                                    (store) =>
                                      !(vendorStores[vendor.id] || []).some((vs) => vs.id === store.id)
                                  )
                                  .map((store) => (
                                    <option key={store.id} value={store.id}>
                                      {store.name}
                                    </option>
                                  ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
