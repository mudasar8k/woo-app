import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'

export async function GET(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      `SELECT s.id, s.name, s.store_url, s.status
       FROM stores s
       INNER JOIN admin_stores as_st ON s.id = as_st.store_id
       WHERE as_st.user_id = $1
       ORDER BY s.name`,
      [id]
    )
    
    return NextResponse.json(result.rows)
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}

export async function POST(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    let body
    try {
      body = await request.json()
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      )
    }
    
    const { store_id } = body

    if (!store_id) {
      return NextResponse.json(
        { error: 'store_id is required' },
        { status: 400 }
      )
    }

    await db.query(
      `INSERT INTO admin_stores (user_id, store_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, store_id) DO NOTHING`,
      [id, store_id]
    )

    return NextResponse.json({ message: 'Store assigned successfully' })
  } catch (error) {
    console.error('Error assigning store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}


