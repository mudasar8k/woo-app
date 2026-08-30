'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'

export default function Navbar({ user }) {
  const pathname = usePathname()

  const isActive = (path) => {
    return pathname === path || pathname?.startsWith(path)
  }

  return (
    <nav className="bg-white shadow-sm border-b">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-16">
          <div className="flex space-x-8">
            <Link href="/dashboard" className="text-xl font-bold text-indigo-600">
              WooApp
            </Link>
            
            {user.role === 'super_admin' && (
              <>
                <Link
                  href="/super-admin/stores"
                  className={`px-3 py-2 rounded-md text-sm font-medium ${
                    isActive('/super-admin/stores')
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Stores
                </Link>
                <Link
                  href="/super-admin/vendors"
                  className={`px-3 py-2 rounded-md text-sm font-medium ${
                    isActive('/super-admin/vendors')
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Vendors
                </Link>
                <Link
                  href="/super-admin/users"
                  className={`px-3 py-2 rounded-md text-sm font-medium ${
                    isActive('/super-admin/users')
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Users
                </Link>
              </>
            )}
          </div>

          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-600">
              {user.name} ({user.role === 'super_admin' ? 'Super Admin' : 'Admin'})
            </span>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}






