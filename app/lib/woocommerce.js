const axios = require('axios')

class WooCommerceClient {
  constructor(storeUrl, consumerKey, consumerSecret) {
    this.baseURL = storeUrl.endsWith('/') ? storeUrl : `${storeUrl}/`
    this.consumerKey = consumerKey
    this.consumerSecret = consumerSecret

    // Create axios instance with basic auth
    this.client = axios.create({
      baseURL: `${this.baseURL}wp-json/wc/v3/`,
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
      timeout: 120000, // Increased to 120 seconds for large batch operations
    })
  }

  async createProduct(productData) {
    try {
      const response = await this.client.post('products', productData)
      return response.data
    } catch (error) {
      console.error('Error creating product:', error.response?.data || error.message)
      throw error
    }
  }

  async updateProduct(productId, productData) {
    try {
      const response = await this.client.put(`products/${productId}`, productData)
      return response.data
    } catch (error) {
      console.error('Error updating product:', error.response?.data || error.message)
      throw error
    }
  }

  async createVariation(productId, variationData) {
    try {
      const response = await this.client.post(`products/${productId}/variations`, variationData)
      return response.data
    } catch (error) {
      console.error('Error creating variation:', error.response?.data || error.message)
      throw error
    }
  }

  async updateVariation(productId, variationId, variationData) {
    try {
      const response = await this.client.put(
        `products/${productId}/variations/${variationId}`,
        variationData
      )
      return response.data
    } catch (error) {
      console.error('Error updating variation:', error.response?.data || error.message)
      throw error
    }
  }

  async batchVariations(productId, batchData) {
    try {
      // Use longer timeout for batch operations
      const response = await this.client.post(
        `products/${productId}/variations/batch`,
        batchData,
        { timeout: 120000 } // 120 seconds for large batches
      )
      return response.data
    } catch (error) {
      console.error('Error batch creating variations:', error.response?.data || error.message)
      throw error
    }
  }

  async getCategories(params = {}) {
    try {
      const response = await this.client.get('products/categories', { params })
      return response.data
    } catch (error) {
      console.error('Error fetching categories:', error.response?.data || error.message)
      throw error
    }
  }

  async createCategory(categoryData) {
    try {
      const response = await this.client.post('products/categories', categoryData)
      return response.data
    } catch (error) {
      console.error('Error creating category:', error.response?.data || error.message)
      throw error
    }
  }

  /**
   * Resolve a brand name to a WooCommerce Brands term id (products/brands),
   * creating the brand when it does not exist. Returns null if Brands is
   * unavailable on the store.
   */
  async getOrCreateBrand(brandName, cache = null) {
    const name = String(brandName || '').trim()
    if (!name) return null

    const cacheKey = name.toLowerCase()
    if (cache instanceof Map && cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    try {
      const search = await this.client.get('products/brands', {
        params: { search: name, per_page: 100 },
      })
      const existing = (search.data || []).find(
        (b) => String(b.name || '').toLowerCase() === cacheKey
      )
      if (existing?.id) {
        if (cache instanceof Map) cache.set(cacheKey, existing.id)
        return existing.id
      }

      const created = await this.client.post('products/brands', { name })
      const id = created.data?.id || null
      if (cache instanceof Map && id) cache.set(cacheKey, id)
      return id
    } catch (error) {
      // Older WC / Brands disabled — sync can continue without native brands.
      console.warn(
        'WooCommerce Brands unavailable or failed for',
        name,
        error.response?.data || error.message
      )
      return null
    }
  }

  async getProduct(productId) {
    try {
      const response = await this.client.get(`products/${productId}`)
      return response.data
    } catch (error) {
      console.error('Error fetching product:', error.response?.data || error.message)
      throw error
    }
  }

  async getOrders(params = {}) {
    try {
      const response = await this.client.get('orders', { params })
      return response.data
    } catch (error) {
      console.error('Error fetching orders:', error.response?.data || error.message)
      throw error
    }
  }

  async getOrder(orderId) {
    try {
      const response = await this.client.get(`orders/${orderId}`)
      return response.data
    } catch (error) {
      console.error('Error fetching order:', error.response?.data || error.message)
      throw error
    }
  }

  async updateOrder(orderId, orderData) {
    try {
      const response = await this.client.put(`orders/${orderId}`, orderData)
      return response.data
    } catch (error) {
      console.error('Error updating order:', error.response?.data || error.message)
      throw error
    }
  }

  async testConnection() {
    try {
      // Test connection by fetching products with limit 1
      // This is a lightweight way to verify credentials work
      const response = await this.client.get('products', { params: { per_page: 1 } })
      return { success: true, data: { message: 'Connection successful', products_count: response.headers['x-wp-total'] || 'N/A' } }
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'Failed to connect to WooCommerce',
      }
    }
  }
}

module.exports = WooCommerceClient






