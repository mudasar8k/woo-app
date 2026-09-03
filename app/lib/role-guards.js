/**
 * Reject non-super-admin callers for upload and product approval routes.
 */
export function requireSuperAdminApi(session) {
  if (!session) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  if (session.user.role !== 'super_admin') {
    return { ok: false, status: 403, error: 'Only super admins can perform this action' }
  }
  return { ok: true }
}

/**
 * Allow super_admin or store admin (admin). Store scoping is caller's responsibility.
 */
export function requireAdminOrSuperAdminApi(session) {
  if (!session) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  if (session.user.role !== 'super_admin' && session.user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Unauthorized' }
  }
  return { ok: true }
}

/**
 * Reject super-admin callers for sync routes (store admins sync only).
 */
export function requireStoreAdminApi(session) {
  if (!session) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  if (session.user.role === 'super_admin') {
    return { ok: false, status: 403, error: 'Only store admins can sync products' }
  }
  if (session.user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Unauthorized' }
  }
  return { ok: true }
}

/**
 * Verify a store admin is assigned to the given store.
 */
export async function verifyAdminStoreAccess(db, userId, storeId) {
  const accessCheck = await db.query(
    'SELECT id FROM admin_stores WHERE user_id = $1 AND store_id = $2',
    [userId, storeId]
  )
  return accessCheck.rows.length > 0
}

/**
 * Authenticate Ralawise sync endpoint calls via NextAuth session or Bearer RALAWISE_SYNC_CRON_SECRET.
 */
export async function authenticateSyncJobRequest(request, job, db, auth) {
  const cronSecret = process.env.RALAWISE_SYNC_CRON_SECRET
  if (cronSecret) {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const xCronHeader = request.headers.get('x-cron-secret') || ''
    if (token === cronSecret || xCronHeader === cronSecret) {
      return { ok: true, isCron: true }
    }
  }

  const session = await auth()
  const roleCheck = requireAdminOrSuperAdminApi(session)
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.error, status: roleCheck.status }
  }

  if (job && session?.user?.role === 'admin') {
    const hasAccess = await verifyAdminStoreAccess(db, session.user.id, job.store_id)
    if (!hasAccess) {
      return { ok: false, error: 'Unauthorized access to this store', status: 403 }
    }
  }

  return { ok: true, session, isCron: false }
}
