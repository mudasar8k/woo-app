import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'

export async function GET(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'SELECT id, name, email, contact_info, status FROM vendors WHERE id = $1',
      [id]
    )
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Vendor not found' },
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
    const { name, email, contact_info, status } = body

    if (!name) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      )
    }

    const result = await db.query(
      `UPDATE vendors 
       SET name = $1, email = $2, contact_info = $3, status = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, name, email, contact_info, status, updated_at`,
      [name, email || null, contact_info || null, status || 'active', id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Vendor not found' },
        { status: 404 }
      )
    }

    return NextResponse.json(result.rows[0])
  } catch (error) {
    console.error('Error updating vendor:', error)
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
      'DELETE FROM vendors WHERE id = $1 RETURNING id',
      [id]
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Vendor not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ message: 'Vendor deleted successfully' })
  } catch (error) {
    console.error('Error deleting vendor:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}




