import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../lib/auth'
import db from '../../../lib/db'
import bcrypt from 'bcryptjs'

export async function DELETE(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id } = await params
    
    const result = await db.query(
      'DELETE FROM users WHERE id = $1 AND role = $2 RETURNING id',
      [id, 'admin']
    )

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ message: 'User deleted successfully' })
  } catch (error) {
    console.error('Error deleting user:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}


