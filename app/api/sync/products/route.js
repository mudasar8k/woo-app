import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import { auth } from '../../auth/[...nextauth]/route'
import { requireStoreAdminApi, verifyAdminStoreAccess } from '../../../lib/role-guards'
import {
  resolveCostPrice,
  resolveItemPrice,
  loadStorePricingEngine,
  loadProductStoreOverrides,
} from '../../../lib/pricing'
import { getStorePricingContext } from '../../../lib/app-settings'

const WooCommerceClient = require('../../../lib/woocommerce')

export async function POST(request) {
  try {
    const session = await auth()
    const roleCheck = requireStoreAdminApi(session)
    if (!roleCheck.ok) {
      return NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status })
    }

    const body = await request.json()
    const { store_id, sync_type = 'products' } = body

    if (!store_id) {
      return NextResponse.json({ error: 'Store ID is required' }, { status: 400 })
    }

    const hasAccess = await verifyAdminStoreAccess(db, session.user.id, store_id)
    if (!hasAccess) {
      return NextResponse.json({ error: 'Unauthorized access to this store' }, { status: 403 })
    }

    // Get store credentials
    const storeResult = await db.query(
      'SELECT id, name, store_url, consumer_key, consumer_secret, connection_method, price_rule_percent FROM stores WHERE id = $1',
      [store_id]
    )

    if (storeResult.rows.length === 0) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 })
    }

    const store = storeResult.rows[0]
    const pricing = await getStorePricingContext(store)
    store.price_rule_percent = pricing.effective

    if (store.connection_method === 'plugin') {
      return NextResponse.json(
        { error: 'This store uses the WooApp Connector plugin, which pulls approved products itself - WooApp does not push to it. Trigger an import from WordPress admin instead.' },
        { status: 400 }
      )
    }

    if (!store.store_url || !store.consumer_key || !store.consumer_secret) {
      return NextResponse.json(
        { error: 'Store WooCommerce credentials are not configured' },
        { status: 400 }
      )
    }

    // Create sync log
    const syncLogResult = await db.query(
      `INSERT INTO sync_logs (store_id, sync_type, status, initiated_by)
       VALUES ($1, $2, 'running', $3)
       RETURNING id`,
      [store_id, sync_type, session.user.id]
    )

    const syncLogId = syncLogResult.rows[0].id

    // Get approved products (approval is global - see export/products/route.js;
    // product_stores is consulted only for this store's existing woo_product_id)
    const productsResult = await db.query(
      `SELECT p.id, p.sku, p.name, p.description, p.short_description, p.price, p.regular_price,
              p.sale_price, p.stock_quantity, p.manage_stock, p.stock_status, p.categories, p.tags, p.images,
              p.attributes, p.brand, ven.name AS vendor_name, ps.woo_product_id
       FROM products p
       INNER JOIN vendor_stores vs ON vs.vendor_id = p.vendor_id AND vs.store_id = $1
       LEFT JOIN product_stores ps ON ps.product_id = p.id AND ps.store_id = $1
       LEFT JOIN vendors ven ON ven.id = p.vendor_id
       WHERE p.status = 'approved'
       ORDER BY p.id`,
      [store_id]
    )

    const products = productsResult.rows

    if (products.length === 0) {
      // Update sync log with no products message
      await db.query(
        `UPDATE sync_logs 
         SET status = 'completed', items_processed = 0, items_succeeded = 0, 
             items_failed = 0, completed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [syncLogId]
      )

      return NextResponse.json({
        syncId: syncLogId,
        message: 'No approved products to sync',
        processed: 0,
        succeeded: 0,
        failed: 0,
      })
    }

    const wooClient = new WooCommerceClient(
      store.store_url,
      store.consumer_key,
      store.consumer_secret
    )

    let processed = 0
    let succeeded = 0
    let failed = 0
    const errors = []

    // Helper function to parse attributes from variations
    const parseAttributesFromVariations = (variations) => {
      const attributeMap = new Map()
      
      for (const variation of variations) {
        if (!variation.attributes) continue
        
        // Parse attributes - format: "Colour: Red; Size: Large" or "Colour=Red;Size=Large"
        const attrPairs = variation.attributes.split(';').map(a => a.trim()).filter(Boolean)
        
        for (const pair of attrPairs) {
          let attrName, attrValue
          
          if (pair.includes(':')) {
            [attrName, attrValue] = pair.split(':').map(s => s.trim())
          } else if (pair.includes('=')) {
            [attrName, attrValue] = pair.split('=').map(s => s.trim())
          } else {
            continue
          }
          
          if (!attrName || !attrValue) continue
          
          if (!attributeMap.has(attrName)) {
            attributeMap.set(attrName, new Set())
          }
          attributeMap.get(attrName).add(attrValue)
        }
      }
      
      // Convert to WooCommerce format
      const wooAttributes = []
      for (const [name, values] of attributeMap.entries()) {
        wooAttributes.push({
          id: 0, // Will be created by WooCommerce
          name: name,
          position: wooAttributes.length,
          visible: true,
          variation: true,
          options: Array.from(values),
        })
      }
      
      return wooAttributes
    }

    // Sync each product
    for (const product of products) {
      try {
        processed++
        
        // Step 1: Check if product has ANY variations (regardless of status) to determine product type
        // Step 2: Get only APPROVED variations for syncing
        let allVariations = []
        let approvedVariations = []
        let hasVariations = false
        
        if (product.sku) {
          // First try: Match by parent_sku (preferred method) - check for ANY variations.
          // parent_sku is globally unique to one canonical product now, so
          // no store filter is needed here.
          let checkResult = await db.query(
            `SELECT COUNT(*) as count
             FROM product_variations pv
             WHERE TRIM(pv.parent_sku) = TRIM($1)`,
            [product.sku]
          )
          
          hasVariations = parseInt(checkResult.rows[0].count) > 0
          
          // Fallback: If no variations found by parent_sku, try by product_id
          if (!hasVariations) {
            console.log(`No variations found by parent_sku for ${product.sku}, trying product_id...`)
            checkResult = await db.query(
              `SELECT COUNT(*) as count
               FROM product_variations pv
               WHERE pv.product_id = $1`,
              [product.id]
            )
            hasVariations = parseInt(checkResult.rows[0].count) > 0
          }
          
          // Now get only APPROVED variations for syncing
          if (hasVariations) {
            let variationsResult = await db.query(
              `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price,
                      pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image,
                      pv.tax_class, pv.images, pv.woo_variation_id, pv.status
               FROM product_variations pv
               WHERE TRIM(pv.parent_sku) = TRIM($1)
                 AND pv.status = 'approved'
               ORDER BY pv.id`,
              [product.sku]
            )
            
            approvedVariations = variationsResult.rows
            
            // Fallback: If no approved variations found by parent_sku, try by product_id
            if (approvedVariations.length === 0) {
              variationsResult = await db.query(
                `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                        pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                        pv.tax_class, pv.images, pv.woo_variation_id, pv.status
                 FROM product_variations pv
                 WHERE pv.product_id = $1 
                   AND pv.status = 'approved'
                 ORDER BY pv.id`,
                [product.id]
              )
              approvedVariations = variationsResult.rows
            }
          }
          
          // Debug logging
          if (hasVariations) {
            console.log(`✓ Product ${product.id} (SKU: ${product.sku}) has variations - will create VARIABLE product`)
            console.log(`  Found ${approvedVariations.length} approved variations to sync`)
          } else {
            console.log(`✗ Product ${product.id} (SKU: ${product.sku}) has no variations - will create SIMPLE product`)
          }
        } else {
          // No SKU, but still check by product_id
          const checkResult = await db.query(
            `SELECT COUNT(*) as count
             FROM product_variations pv
             WHERE pv.product_id = $1`,
            [product.id]
          )
          hasVariations = parseInt(checkResult.rows[0].count) > 0
          
          if (hasVariations) {
            const variationsResult = await db.query(
              `SELECT pv.id, pv.sku, pv.attributes, pv.price, pv.regular_price, pv.sale_price, 
                      pv.stock_quantity, pv.manage_stock, pv.stock_status, pv.image, 
                      pv.tax_class, pv.images, pv.woo_variation_id, pv.status
               FROM product_variations pv
               WHERE pv.product_id = $1 
                 AND pv.status = 'approved'
               ORDER BY pv.id`,
              [product.id]
            )
            approvedVariations = variationsResult.rows
            console.log(`✓ Product ${product.id} (no SKU) has variations by product_id - will create VARIABLE product`)
            console.log(`  Found ${approvedVariations.length} approved variations to sync`)
          } else {
            console.log(`✗ Product ${product.id} (no SKU) has no variations - will create SIMPLE product`)
          }
        }
        
        // Use approved variations for syncing, but use hasVariations for product type
        const variations = approvedVariations
        
        // Convert to WooCommerce format
        const wooProductData = {
          name: product.name,
          type: hasVariations ? 'variable' : 'simple',
          sku: product.sku || undefined,
          description: product.description || '',
          short_description: product.short_description || '',
          status: 'publish',
        }
        
        // Debug: Log product type decision
        console.log(`Creating ${wooProductData.type} product for ${product.name} (SKU: ${product.sku})`)

        // For simple products, add pricing and stock
        if (!hasVariations) {
          const productOverride = productOverridesMap.get(product.id) || null
        const parentCost = resolveCostPrice(product)
        const sellPrice = resolveItemPrice(parentCost, storeContext, rangeRules, productOverride, product.categories, categoryRules).sellingPrice
          wooProductData.regular_price = sellPrice !== null ? sellPrice.toString() : ''
          wooProductData.sale_price = product.sale_price?.toString() || undefined
          wooProductData.manage_stock = product.manage_stock || (product.stock_quantity !== null)
          wooProductData.stock_quantity = product.stock_quantity || undefined
          wooProductData.stock_status = product.stock_status || 'instock'
          
          // Remove empty sale_price
          if (!wooProductData.sale_price) {
            delete wooProductData.sale_price
          }
        } else {
          // For variable products: Step 1 - Add attributes (no pricing/stock on parent)
          // Variable products MUST have attributes in WooCommerce
          // Get ALL variations (not just approved) to extract attributes
          let allVariationsForAttributes = []
          if (product.sku) {
            let attrResult = await db.query(
              `SELECT pv.attributes
               FROM product_variations pv
               WHERE TRIM(pv.parent_sku) = TRIM($1)
               UNION
               SELECT pv.attributes
               FROM product_variations pv
               WHERE pv.product_id = $2`,
              [product.sku, product.id]
            )
            allVariationsForAttributes = attrResult.rows
          } else {
            let attrResult = await db.query(
              `SELECT pv.attributes
               FROM product_variations pv
               WHERE pv.product_id = $1`,
              [product.id]
            )
            allVariationsForAttributes = attrResult.rows
          }
          
          const wooAttributes = parseAttributesFromVariations(allVariationsForAttributes)
          if (wooAttributes.length > 0) {
            wooProductData.attributes = wooAttributes
            console.log(`Added ${wooAttributes.length} attributes to variable product`)
          } else {
            console.error(`ERROR: Variable product ${product.name} has variations but no attributes could be extracted!`)
            console.error(`All variations:`, allVariationsForAttributes)
            // Still create as variable, but WooCommerce might reject it without attributes
            // This should not happen if variations have proper attributes
          }
          // Variable products don't have pricing/stock on parent - only on variations
        }

        // Parse categories if provided
        if (product.categories) {
          const categoryNames = product.categories.split(',').map(cat => cat.trim()).filter(Boolean)
          if (categoryNames.length > 0) {
            wooProductData.categories = categoryNames.map(name => ({ name }))
          }
        }

        // Parse tags if provided
        if (product.tags) {
          const tagNames = product.tags.split(',').map(tag => tag.trim()).filter(Boolean)
          if (tagNames.length > 0) {
            wooProductData.tags = tagNames.map(name => ({ name }))
          }
        }

        // Parse images if provided
        if (product.images) {
          const imageUrls = product.images.split(',').map(url => url.trim()).filter(Boolean)
          if (imageUrls.length > 0) {
            wooProductData.images = imageUrls.map(src => ({ src }))
          }
        }

        // Product-level attributes: Brand and Vendor (non-variation)
        const productAttributes = [...(wooProductData.attributes || [])]
        let attrPosition = productAttributes.length

        if (product.brand) {
          productAttributes.push({
            id: 0,
            name: 'Brand',
            position: attrPosition++,
            visible: true,
            variation: false,
            options: [product.brand],
          })

          // Native WooCommerce Brands taxonomy (Products → Brands)
          const brandId = await wooClient.getOrCreateBrand(product.brand)
          if (brandId) {
            wooProductData.brands = [{ id: brandId }]
          }
        }

        if (product.vendor_name) {
          productAttributes.push({
            id: 0,
            name: 'Vendor',
            position: attrPosition++,
            visible: true,
            variation: false,
            options: [product.vendor_name],
          })
        }

        if (productAttributes.length > 0) {
          wooProductData.attributes = productAttributes
        }

        let wooProduct

        // Update existing or create new
        if (product.woo_product_id) {
          wooProduct = await wooClient.updateProduct(product.woo_product_id, wooProductData)
        } else {
          wooProduct = await wooClient.createProduct(wooProductData)
        }

        // Update product in database (per-store sync state - upsert since a
        // brand-new store has no pre-existing product_stores row yet)
        await db.query(
          `INSERT INTO product_stores (product_id, store_id, woo_product_id, status)
           VALUES ($1, $2, $3, 'synced')
           ON CONFLICT (product_id, store_id)
           DO UPDATE SET woo_product_id = $3, status = 'synced', updated_at = CURRENT_TIMESTAMP`,
          [product.id, store_id, wooProduct.id]
        )

        // Step 2: Sync variations if product has them (after parent is created)
        if (hasVariations && wooProduct.id) {
          for (const variation of variations) {
            try {
              // Parse variation attributes to WooCommerce format
              const variationAttributes = []
              if (variation.attributes) {
                const attrPairs = variation.attributes.split(';').map(a => a.trim()).filter(Boolean)
                for (const pair of attrPairs) {
                  let attrName, attrValue
                  
                  if (pair.includes(':')) {
                    [attrName, attrValue] = pair.split(':').map(s => s.trim())
                  } else if (pair.includes('=')) {
                    [attrName, attrValue] = pair.split('=').map(s => s.trim())
                  } else {
                    continue
                  }
                  
                  if (attrName && attrValue) {
                    // Find attribute ID from parent product
                    const parentAttr = wooProduct.attributes?.find(a => a.name === attrName)
                    if (parentAttr) {
                      variationAttributes.push({
                        id: parentAttr.id,
                        name: attrName,
                        option: attrValue,
                      })
                    }
                  }
                }
              }

              const varCost = resolveCostPrice(variation)
              const sellPrice = resolveItemPrice(varCost, storeContext, rangeRules, productOverride, product.categories, categoryRules).sellingPrice
              const wooVariationData = {
                sku: variation.sku || undefined,
                regular_price: sellPrice !== null ? sellPrice.toString() : '',
                sale_price: variation.sale_price?.toString() || undefined,
                manage_stock: variation.manage_stock || (variation.stock_quantity !== null),
                stock_quantity: variation.stock_quantity || undefined,
                stock_status: variation.stock_status || 'instock',
                status: 'publish',
              }

              // Remove empty sale_price
              if (!wooVariationData.sale_price) {
                delete wooVariationData.sale_price
              }

              // Add attributes
              if (variationAttributes.length > 0) {
                wooVariationData.attributes = variationAttributes
              }

              if (variation.tax_class) {
                wooVariationData.tax_class = variation.tax_class
              }

              const imgSrc = variation.image || (variation.images ? String(variation.images).split(',')[0]?.trim() : null)
              if (imgSrc) {
                wooVariationData.image = { src: imgSrc }
              }

              let wooVariation

              // Update existing or create new variation
              if (variation.woo_variation_id) {
                wooVariation = await wooClient.updateVariation(
                  wooProduct.id,
                  variation.woo_variation_id,
                  wooVariationData
                )
              } else {
                wooVariation = await wooClient.createVariation(wooProduct.id, wooVariationData)
              }

              // Update variation in database
              await db.query(
                `UPDATE product_variations 
                 SET woo_variation_id = $1, status = 'synced', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [wooVariation.id, variation.id]
              )
            } catch (variationError) {
              const errorMsg = variationError.response?.data?.message || variationError.message || 'Unknown error'
              errors.push(`Variation ${variation.id} (${variation.sku || 'N/A'}): ${errorMsg}`)
              console.error(`Error syncing variation ${variation.id}:`, errorMsg)
            }
          }
        }

        succeeded++
      } catch (error) {
        failed++
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error'
        errors.push(`Product ${product.id} (${product.sku || product.name}): ${errorMsg}`)
        console.error(`Error syncing product ${product.id}:`, errorMsg)
      }
    }

    // Update sync log
    await db.query(
      `UPDATE sync_logs 
       SET status = $1, items_processed = $2, items_succeeded = $3, 
           items_failed = $4, error_message = $5, completed_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        failed > 0 && succeeded === 0 ? 'failed' : 'completed',
        processed,
        succeeded,
        failed,
        errors.length > 0 ? errors.slice(0, 10).join('\n') : null, // Limit error message length
        syncLogId
      ]
    )

    // Update store last sync time
    await db.query(
      'UPDATE stores SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1',
      [store_id]
    )

    return NextResponse.json({
      syncId: syncLogId,
      message: 'Sync completed',
      processed,
      succeeded,
      failed,
      errors: errors.length > 0 ? errors.slice(0, 20) : undefined, // Return first 20 errors
    })
  } catch (error) {
    console.error('Sync error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to sync products' },
      { status: 500 }
    )
  }
}
