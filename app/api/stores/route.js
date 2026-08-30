import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import { assignAllVendorsToStore } from '../../lib/vendor-store-assignment'

export async function GET() {
  try {
    await requireSuperAdmin()

    const result = await db.query(
      'SELECT id, name, store_url, status, connection_method, last_sync_at, created_at FROM stores ORDER BY created_at DESC'
    )

    return NextResponse.json(result.rows)
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 401 }
    )
  }
}

export async function POST(request) {
  try {
    await requireSuperAdmin()

    const body = await request.json()
    const { name, store_url, consumer_key, consumer_secret, status } = body
    const connectionMethod = body.connection_method === 'plugin' ? 'plugin' : 'api'
    const priceRulePercent =
      body.price_rule_percent === '' || body.price_rule_percent === null || body.price_rule_percent === undefined
        ? null
        : Number(body.price_rule_percent)

    if (!name || !store_url) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (connectionMethod === 'api' && (!consumer_key || !consumer_secret)) {
      return NextResponse.json(
        { error: 'Consumer Key and Consumer Secret are required for the REST API connection method' },
        { status: 400 }
      )
    }

    if (priceRulePercent !== null && !Number.isFinite(priceRulePercent)) {
      return NextResponse.json(
        { error: 'Price rule percent must be a number' },
        { status: 400 }
      )
    }

    const exportApiKey = crypto.randomBytes(24).toString('hex')

    const result = await db.query(
      `INSERT INTO stores (name, store_url, consumer_key, consumer_secret, status, export_api_key, connection_method, price_rule_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, store_url, status, connection_method, price_rule_percent, created_at`,
      [
        name,
        store_url,
        connectionMethod === 'api' ? consumer_key : (consumer_key || null),
        connectionMethod === 'api' ? consumer_secret : (consumer_secret || null),
        status || 'active',
        exportApiKey,
        connectionMethod,
        priceRulePercent,
      ]
    )

    const store = result.rows[0]
    await assignAllVendorsToStore(store.id)

    return NextResponse.json(store, { status: 201 })
  } catch (error) {
    console.error('Error creating store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}






