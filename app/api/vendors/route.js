import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'

export async function GET() {
  try {
    await requireSuperAdmin()
    
    const result = await db.query(
      'SELECT id, name, email, contact_info, status, created_at FROM vendors ORDER BY created_at DESC'
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
    const { name, email, contact_info, status } = body

    if (!name) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      )
    }

    const result = await db.query(
      `INSERT INTO vendors (name, email, contact_info, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, contact_info, status, created_at`,
      [name, email || null, contact_info || null, status || 'active']
    )

    return NextResponse.json(result.rows[0], { status: 201 })
  } catch (error) {
    console.error('Error creating vendor:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}






