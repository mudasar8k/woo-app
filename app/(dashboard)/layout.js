import { redirect } from 'next/navigation'
import { getSession } from '../lib/auth'
import Sidebar from '../components/Sidebar'
import db from '../lib/db'

export default async function DashboardLayout({ children }) {
  const session = await getSession()

  if (!session) {
    redirect('/login')
  }

  // Fetch store ID for admin users
  let storeId = null
  if (session.user.role === 'admin') {
    const result = await db.query(
      'SELECT store_id FROM admin_stores WHERE user_id = $1 LIMIT 1',
      [session.user.id]
    )
    if (result.rows.length > 0) {
      storeId = result.rows[0].store_id
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar user={session.user} storeId={storeId} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}


