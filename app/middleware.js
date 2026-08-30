import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token
    const isSuperAdmin = req.nextUrl.pathname.startsWith('/super-admin')
    const isAdmin = req.nextUrl.pathname.startsWith('/admin')

    // Redirect based on role
    if (token?.role === 'super_admin' && req.nextUrl.pathname.startsWith('/admin')) {
      // Super admin can access admin routes too
      return NextResponse.next()
    }

    if (token?.role === 'admin' && isSuperAdmin) {
      return NextResponse.redirect(new URL('/unauthorized', req.url))
    }

    if (token?.role === 'super_admin' && !isSuperAdmin && !isAdmin && req.nextUrl.pathname !== '/login') {
      return NextResponse.redirect(new URL('/super-admin/stores', req.url))
    }

    return NextResponse.next()
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        // Allow access to login page without auth
        if (req.nextUrl.pathname === '/login' || req.nextUrl.pathname === '/unauthorized') {
          return true
        }
        return !!token
      },
    },
  }
)

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}






