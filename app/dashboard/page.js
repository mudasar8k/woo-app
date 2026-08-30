import { redirect } from 'next/navigation'
import { getSession } from '../lib/auth'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/app/components/ui/card'

export default async function DashboardPage() {
  const session = await getSession()

  if (!session || !session.user) {
    redirect('/login')
  }

  if (session.user.role === 'super_admin') {
    redirect('/super-admin/stores')
  } else if (session.user.role === 'admin') {
    // Get the admin's assigned store
    const db = require('../lib/db')
    const result = await db.query(
      'SELECT store_id FROM admin_stores WHERE user_id = $1 LIMIT 1',
      [session.user.id]
    )

    if (result.rows.length > 0) {
      redirect(`/admin/store/${result.rows[0].store_id}`)
    } else {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-2xl font-bold text-center">
                No Store Assigned
              </CardTitle>
              <CardDescription className="text-center">
                Please contact a Super Admin to assign you to a store.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )
    }
  }

  return null
}


