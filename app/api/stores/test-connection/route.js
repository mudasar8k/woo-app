import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../lib/auth'

const WooCommerceClient = require('../../../lib/woocommerce')

export async function POST(request) {
  try {
    await requireSuperAdmin()

    const body = await request.json()
    const { store_url, consumer_key, consumer_secret } = body

    if (!store_url || !consumer_key || !consumer_secret) {
      return NextResponse.json(
        { error: 'Store URL, Consumer Key, and Consumer Secret are required' },
        { status: 400 }
      )
    }

    // Test connection using WooCommerceClient
    const wooClient = new WooCommerceClient(
      store_url,
      consumer_key,
      consumer_secret
    )

    const result = await wooClient.testConnection()

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: 'Connection successful! WooCommerce API credentials are valid.',
        data: result.data,
      })
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to connect to WooCommerce',
        },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error('Test connection error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.response?.data?.message || error.message || 'Failed to test connection',
      },
      { status: 500 }
    )
  }
}
