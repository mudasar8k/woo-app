/**
 * Centralized API query functions
 * All API calls are handled through this file
 */

// Auth API functions
export const authQueries = {
  signIn: async ({ email, password }) => {
    const response = await fetch('/api/auth/callback/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email,
        password,
        redirect: 'false',
      }),
    })
    
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Login failed')
    }
    
    return await response.json()
  },

  signOut: async () => {
    const response = await fetch('/api/auth/signout', {
      method: 'POST',
    })
    
    if (!response.ok) {
      throw new Error('Sign out failed')
    }
    
    return await response.json()
  },

  getSession: async () => {
    const response = await fetch('/api/auth/session')
    
    if (!response.ok) {
      return null
    }
    
    return await response.json()
  },
}

// Stores API functions
export const storeQueries = {
  getAll: async () => {
    const response = await fetch('/api/stores')
    if (!response.ok) throw new Error('Failed to fetch stores')
    return await response.json()
  },

  getById: async (id) => {
    const response = await fetch(`/api/stores/${id}`)
    if (!response.ok) throw new Error('Failed to fetch store')
    return await response.json()
  },

  create: async (data) => {
    const response = await fetch('/api/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to create store')
    }
    return await response.json()
  },

  update: async ({ id, ...data }) => {
    const response = await fetch(`/api/stores/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update store')
    }
    return await response.json()
  },

  delete: async (id) => {
    const response = await fetch(`/api/stores/${id}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to delete store')
    }
    return await response.json()
  },
}

// Users API functions
export const userQueries = {
  getAll: async () => {
    const response = await fetch('/api/users')
    if (!response.ok) throw new Error('Failed to fetch users')
    return await response.json()
  },

  getById: async (id) => {
    const response = await fetch(`/api/users/${id}`)
    if (!response.ok) throw new Error('Failed to fetch user')
    return await response.json()
  },

  create: async (data) => {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to create user')
    }
    return await response.json()
  },

  update: async ({ id, ...data }) => {
    const response = await fetch(`/api/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update user')
    }
    return await response.json()
  },

  delete: async (id) => {
    const response = await fetch(`/api/users/${id}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to delete user')
    }
    return await response.json()
  },
}

// Vendors API functions
export const vendorQueries = {
  getAll: async () => {
    const response = await fetch('/api/vendors')
    if (!response.ok) throw new Error('Failed to fetch vendors')
    return await response.json()
  },

  getById: async (id) => {
    const response = await fetch(`/api/vendors/${id}`)
    if (!response.ok) throw new Error('Failed to fetch vendor')
    return await response.json()
  },

  create: async (data) => {
    const response = await fetch('/api/vendors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to create vendor')
    }
    return await response.json()
  },

  update: async ({ id, ...data }) => {
    const response = await fetch(`/api/vendors/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update vendor')
    }
    return await response.json()
  },

  delete: async (id) => {
    const response = await fetch(`/api/vendors/${id}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to delete vendor')
    }
    return await response.json()
  },
}

// Products API functions
export const productQueries = {
  getByStoreId: async (storeId) => {
    const response = await fetch(`/api/products?store_id=${storeId}`)
    if (!response.ok) throw new Error('Failed to fetch products')
    return await response.json()
  },

  getById: async (id) => {
    const response = await fetch(`/api/products/${id}`)
    if (!response.ok) throw new Error('Failed to fetch product')
    return await response.json()
  },

  updateStatus: async ({ id, status, storeId }) => {
    const response = await fetch(`/api/products/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, store_id: storeId }),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update product status')
    }
    return await response.json()
  },

  bulkUpdateStatus: async ({ productIds, status, storeId }) => {
    const response = await fetch('/api/products/bulk-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds, status, store_id: storeId }),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update products status')
    }
    return await response.json()
  },
}

// CSV Upload API functions
export const csvQueries = {
  upload: async (formData) => {
    const response = await fetch('/api/csv/upload', {
      method: 'POST',
      body: formData,
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to upload CSV')
    }
    return await response.json()
  },
}

