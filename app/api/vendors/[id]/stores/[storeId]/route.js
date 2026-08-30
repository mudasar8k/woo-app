import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '../../../../../lib/auth'
import db from '../../../../../lib/db'

export async function DELETE(request, { params }) {
  try {
    await requireSuperAdmin()
    const { id, storeId } = await params
    
    await db.query(
      'DELETE FROM vendor_stores WHERE vendor_id = $1 AND store_id = $2',
      [id, storeId]
    )

    return NextResponse.json({ message: 'Store removed successfully' })
  } catch (error) {
    console.error('Error removing store:', error)
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    )
  }
}




