import { auth } from '../api/auth/[...nextauth]/route'
import { redirect } from 'next/navigation'

export async function getSession() {
  return await auth()
}

export async function requireAuth(requiredRole = null) {
  const session = await getSession()
  
  if (!session) {
    redirect('/login')
  }

  if (requiredRole && session.user.role !== requiredRole) {
    redirect('/unauthorized')
  }

  return session
}

export async function requireSuperAdmin() {
  return await requireAuth('super_admin')
}

export async function requireAdmin() {
  const session = await getSession()
  
  if (!session) {
    redirect('/login')
  }

  if (session.user.role !== 'super_admin' && session.user.role !== 'admin') {
    redirect('/unauthorized')
  }

  return session
}


