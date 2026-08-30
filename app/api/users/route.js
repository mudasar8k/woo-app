import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import bcrypt from 'bcryptjs'

export async function GET() {
  try {
    await requireSuperAdmin()
    
    const result = await db.query(
      'SELECT id, email, name, role, created_at FROM users WHERE role = $1 ORDER BY created_at DESC',
      ['admin']
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
    const { name, email, password } = body

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: 'Name, email, and password are required' },
        { status: 400 }
      )
    }

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )

    if (existingUser.rows.length > 0) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 400 }
      )
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10)

    const result = await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [name, email, passwordHash, 'admin']
    )

    return NextResponse.json(result.rows[0], { status: 201 })
  } catch (error) {
    console.error('Error creating user:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}






