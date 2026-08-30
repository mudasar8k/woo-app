import { requireSuperAdmin } from '../../../../lib/auth'
import db from '../../../../lib/db'
import { redirect } from 'next/navigation'
import CSVUploader from '../../../../components/csv-uploader'

export default async function ImportPage({ params, searchParams }) {
  await requireSuperAdmin()
  const { id } = await params
  const resolvedSearchParams = await searchParams
  const storeId = parseInt(id)
  const fileType =
    resolvedSearchParams?.type === 'variations' ? 'variations' : 'products'

  // Get store info
  const storeResult = await db.query(
    'SELECT id, name FROM stores WHERE id = $1',
    [storeId]
  )

  if (storeResult.rows.length === 0) {
    redirect('/dashboard')
  }

  const store = storeResult.rows[0]

  // Get all active vendors (not just those linked to this store)
  const vendorsResult = await db.query(
    `SELECT v.id, v.name 
     FROM vendors v
     WHERE v.status = 'active'
     ORDER BY v.name`
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          {fileType === 'variations' ? 'Import Variations' : 'Import Products'}
        </h1>
        <p className="text-gray-600 mt-1">Store: {store.name}</p>
      </div>
      <CSVUploader
        storeId={storeId}
        vendors={vendorsResult.rows}
        defaultFileType={fileType}
      />
    </div>
  )
}


