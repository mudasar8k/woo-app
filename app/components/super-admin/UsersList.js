'use client'

import Link from 'next/link'
import { useState } from 'react'
import React from 'react'
import { Button } from '@/app/components/ui/button'
import { Users } from 'lucide-react'

export default function UsersList({ users }) {
  const [expandedUser, setExpandedUser] = useState(null)
  const [userStores, setUserStores] = useState({})
  const [availableStores, setAvailableStores] = useState([])

  const loadUserStores = async (userId) => {
    if (userStores[userId]) return

    try {
      const response = await fetch(`/api/users/${userId}/stores`)
      const stores = await response.json()
      setUserStores({ ...userStores, [userId]: stores })
    } catch (error) {
      console.error('Error loading user stores:', error)
    }
  }

  const loadAvailableStores = async () => {
    if (availableStores.length > 0) return

    try {
      const response = await fetch('/api/stores')
      const stores = await response.json()
      setAvailableStores(stores)
    } catch (error) {
      console.error('Error loading stores:', error)
    }
  }

  const assignStoreToUser = async (userId, storeId) => {
    try {
      const response = await fetch(`/api/users/${userId}/stores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId }),
      })

      if (response.ok) {
        await loadUserStores(userId)
        alert('Store assigned successfully')
      } else {
        alert('Failed to assign store')
      }
    } catch (error) {
      console.error('Error assigning store:', error)
      alert('Error assigning store')
    }
  }

  const removeStoreFromUser = async (userId, storeId) => {
    if (!confirm('Are you sure you want to remove this store from the admin?')) {
      return
    }

    try {
      const response = await fetch(`/api/users/${userId}/stores/${storeId}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        await loadUserStores(userId)
        alert('Store removed successfully')
      } else {
        alert('Failed to remove store')
      }
    } catch (error) {
      console.error('Error removing store:', error)
      alert('Error removing store')
    }
  }

  const handleExpand = (userId) => {
    if (expandedUser === userId) {
      setExpandedUser(null)
    } else {
      setExpandedUser(userId)
      loadUserStores(userId)
      loadAvailableStores()
    }
  }

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Users className="h-5 w-5" />
            Admin Users
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Manage store admin accounts and their store assignments
          </p>
        </div>
        <Button asChild>
          <Link href="/super-admin/users/new">Add New Admin</Link>
        </Button>
      </div>
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Email
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {users.length === 0 ? (
            <tr>
              <td colSpan="4" className="px-6 py-12 text-center">
                <Users className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                <p className="text-gray-500 mb-4">No admin users found. Create your first admin user.</p>
                <Button asChild>
                  <Link href="/super-admin/users/new">Add New Admin</Link>
                </Button>
              </td>
            </tr>
          ) : (
            users.map((user) => (
              <React.Fragment key={user.id}>
                <tr>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {user.name}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {user.email}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button
                      onClick={() => handleExpand(user.id)}
                      className="text-indigo-600 hover:text-indigo-900 mr-4"
                    >
                      {expandedUser === user.id ? 'Hide' : 'Manage'} Stores
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Are you sure you want to delete this user?')) {
                          fetch(`/api/users/${user.id}`, { method: 'DELETE' })
                            .then(() => window.location.reload())
                        }
                      }}
                      className="text-red-600 hover:text-red-900"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {expandedUser === user.id && (
                  <tr>
                    <td colSpan="4" className="px-6 py-4 bg-gray-50">
                      <div className="mb-4">
                        <h3 className="text-lg font-medium mb-2">Assigned Stores</h3>
                        {userStores[user.id] && userStores[user.id].length > 0 ? (
                          <ul className="space-y-2">
                            {userStores[user.id].map((store) => (
                              <li key={store.id} className="flex justify-between items-center">
                                <span>{store.name}</span>
                                <button
                                  onClick={() => removeStoreFromUser(user.id, store.id)}
                                  className="text-red-600 hover:text-red-800 text-sm"
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-gray-500">No stores assigned</p>
                        )}
                      </div>
                      <div>
                        <h3 className="text-lg font-medium mb-2">Assign Store</h3>
                        <select
                          onChange={(e) => {
                            if (e.target.value) {
                              assignStoreToUser(user.id, e.target.value)
                              e.target.value = ''
                            }
                          }}
                          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        >
                          <option value="">Select a store...</option>
                          {availableStores
                            .filter(
                              (store) =>
                                !userStores[user.id]?.some((us) => us.id === store.id)
                            )
                            .map((store) => (
                              <option key={store.id} value={store.id}>
                                {store.name}
                              </option>
                            ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}


