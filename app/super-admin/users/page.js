import { requireSuperAdmin } from '../../lib/auth'
import db from '../../lib/db'
import UsersList from '../../components/super-admin/UsersList'

export default async function UsersPage() {
  await requireSuperAdmin()

  const result = await db.query(
    'SELECT id, email, name, role, created_at FROM users WHERE role = $1 ORDER BY created_at DESC',
    ['admin']
  )

  return (
    <div className="space-y-6">
      <UsersList users={result.rows} />
    </div>
  )
}
