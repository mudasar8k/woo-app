import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'

export async function GET(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'SELECT id, name, store_url, consumer_key, consumer_secret, status, export_api_key, connection_method, price_rule_percent FROM stores WHERE id = $1',
      [id]
    )
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json(result.rows[0])
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 401 }
    )
  }
}

export async function PUT(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
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

    const result = await db.query(
      `UPDATE stores
       SET name = $1, store_url = $2, consumer_key = $3, consumer_secret = $4, status = $5,
           connection_method = $6, price_rule_percent = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING id, name, store_url, status, connection_method, price_rule_percent, updated_at`,
      [
        name,
        store_url,
        connectionMethod === 'api' ? consumer_key : (consumer_key || null),
        connectionMethod === 'api' ? consumer_secret : (consumer_secret || null),
        status || 'active',
        connectionMethod,
        priceRulePercent,
        id,
      ]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(result.rows[0])
  } catch (error) {
    console.error('Error updating store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}

export async function DELETE(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'DELETE FROM stores WHERE id = $1 RETURNING id',
      [id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Store not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ message: 'Store deleted successfully' })
  } catch (error) {
    console.error('Error deleting store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}




