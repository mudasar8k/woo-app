import { requireSuperAdmin } from '../../../lib/auth'
import UserForm from '../../../components/super-admin/UserForm'

export default async function NewUserPage() {
  await requireSuperAdmin()

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Add New Admin User</h1>
      <UserForm />
    </div>
  )
}






