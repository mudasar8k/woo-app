import { requireSuperAdmin } from '../../../lib/auth'
import StoreForm from '../../../components/super-admin/StoreForm'

export default async function NewStorePage() {
  await requireSuperAdmin()

  return (
    <div className="container mx-auto py-6 space-y-6">
      <h1 className="text-3xl font-bold">Add New Store</h1>
      <StoreForm />
    </div>
  )
}


