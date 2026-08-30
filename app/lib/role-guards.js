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
