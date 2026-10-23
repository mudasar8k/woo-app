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

    // Cache global attribute/term lookups during a sync request so thousands
    // of products do not repeatedly query the same WooCommerce endpoints.
    this.productAttributeCache = new Map()
    this.productAttributeTermCache = new Map()
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

  async getOrCreateProductAttribute(name, slug) {
    const cleanName = String(name || '').trim()
    const cleanSlug = String(slug || '')
      .trim()
      .toLowerCase()
      .replace(/^pa_/, '')

    if (!cleanName || !cleanSlug) return null

    if (this.productAttributeCache.has(cleanSlug)) {
      return this.productAttributeCache.get(cleanSlug)
    }

    const response = await this.client.get('products/attributes', {
      params: { per_page: 100 },
    })

    const existing = (response.data || []).find((attribute) => {
      const apiSlug = String(attribute.slug || '')
        .toLowerCase()
        .replace(/^pa_/, '')

      return (
        apiSlug === cleanSlug ||
        String(attribute.name || '').toLowerCase() === cleanName.toLowerCase()
      )
    })

    if (existing?.id) {
      this.productAttributeCache.set(cleanSlug, existing.id)
      return existing.id
    }

    const created = await this.client.post('products/attributes', {
      name: cleanName,
      slug: cleanSlug,
      type: 'select',
      order_by: 'menu_order',
      has_archives: true,
    })

    const id = created.data?.id || null
    if (id) {
      this.productAttributeCache.set(cleanSlug, id)
    }

    return id
  }

  async getOrCreateProductAttributeTerm(attributeId, termName) {
    const name = String(termName || '').trim()
    if (!attributeId || !name) return null

    const cacheKey = `${attributeId}:${name.toLowerCase()}`

    if (this.productAttributeTermCache.has(cacheKey)) {
      return this.productAttributeTermCache.get(cacheKey)
    }

    const response = await this.client.get(
      `products/attributes/${attributeId}/terms`,
      {
        params: {
          search: name,
          per_page: 100,
        },
      }
    )

    const existing = (response.data || []).find(
      (term) => String(term.name || '').toLowerCase() === name.toLowerCase()
    )

    if (existing?.id) {
      this.productAttributeTermCache.set(cacheKey, existing.id)
      return existing.id
    }

    const created = await this.client.post(
      `products/attributes/${attributeId}/terms`,
      { name }
    )

    const id = created.data?.id || null
    if (id) {
      this.productAttributeTermCache.set(cacheKey, id)
    }

    return id
  }

  async buildGlobalFilterAttributes(attributesText) {
    const text = String(attributesText || '').trim()
    if (!text) return []

    const parsed = new Map()

    for (const pair of text.split(';').map((value) => value.trim()).filter(Boolean)) {
      const colonIndex = pair.indexOf(':')
      const equalsIndex = pair.indexOf('=')

      let separatorIndex = -1
      if (colonIndex >= 0 && equalsIndex >= 0) {
        separatorIndex = Math.min(colonIndex, equalsIndex)
      } else if (colonIndex >= 0) {
        separatorIndex = colonIndex
      } else if (equalsIndex >= 0) {
        separatorIndex = equalsIndex
      }

      if (separatorIndex <= 0) continue

      const key = pair
        .slice(0, separatorIndex)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')

      const value = pair.slice(separatorIndex + 1).trim()
      if (key && value) {
        parsed.set(key, value)
      }
    }

    const definitions = [
      {
        sourceKey: 'gender',
        name: 'Gender',
        slug: 'gender',
      },
      {
        sourceKey: 'fabric filter',
        name: 'Fabric',
        slug: 'fabric',
      },
      {
        sourceKey: 'weight gsm',
        name: 'Weight (GSM)',
        slug: 'weight_gsm',
      },
      {
        sourceKey: 'age group',
        name: 'Age Group',
        slug: 'agegroup',
      },
    ]

    const attributes = []

    for (const definition of definitions) {
      const value = parsed.get(definition.sourceKey)
      if (!value) continue

      const attributeId = await this.getOrCreateProductAttribute(
        definition.name,
        definition.slug
      )

      if (!attributeId) continue

      await this.getOrCreateProductAttributeTerm(attributeId, value)

      attributes.push({
        id: attributeId,
        visible: true,
        variation: false,
        options: [value],
      })
    }

    return attributes
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






