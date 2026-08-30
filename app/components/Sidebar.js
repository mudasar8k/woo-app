'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Store, Users, Package, LayoutDashboard, LogOut, ShoppingBag, Upload, RefreshCw, Layers, Settings, ClipboardList } from 'lucide-react'
import { cn } from '@/app/lib/utils'

export default function Sidebar({ user, storeId = null }) {
  const pathname = usePathname()

  if (!user) {
    return null
  }

  const isActive = (path) => {
    if (!pathname) return false
    
    // Exact match
    if (pathname === path) return true
    
    // For store dashboard, only match exact path (not sub-paths)
    if (path === `/admin/store/${storeId}`) {
      return pathname === path
    }
    
    // For other paths, match if pathname starts with path followed by '/' or end of string
    // This allows sub-routes like /admin/store/1/products/10 to match /admin/store/1/products
    return pathname.startsWith(path + '/') || pathname === path
  }

  const isSuperAdmin = user.role === 'super_admin'
  const isAdmin = user.role === 'admin'

  const pathnameStoreMatch = pathname?.match(/^\/admin\/store\/(\d+)/)
  const pathnameStoreId = pathnameStoreMatch ? parseInt(pathnameStoreMatch[1], 10) : null
  const effectiveStoreId = storeId || pathnameStoreId

  const baseNavigationItems = [
    {
      name: 'Dashboard',
      href: '/dashboard',
      icon: LayoutDashboard,
      roles: ['super_admin', 'admin'],
    },
    {
      name: 'Stores',
      href: '/super-admin/stores',
      icon: Store,
      roles: ['super_admin'],
    },
    {
      name: 'Upload Catalog',
      href: '/super-admin/upload',
      icon: Upload,
      roles: ['super_admin'],
    },
    {
      name: 'Vendors',
      href: '/super-admin/vendors',
      icon: Package,
      roles: ['super_admin'],
    },
    {
      name: 'Users',
      href: '/super-admin/users',
      icon: Users,
      roles: ['super_admin'],
    },
    {
      name: 'Settings',
      href: '/super-admin/settings',
      icon: Settings,
      roles: ['super_admin'],
    },
  ]

  const adminStoreItems = storeId ? [
    {
      name: 'Store Dashboard',
      href: `/admin/store/${storeId}`,
      icon: LayoutDashboard,
    },
    {
      name: 'Products',
      href: `/admin/store/${storeId}/products`,
      icon: ShoppingBag,
    },
    {
      name: 'Orders',
      href: `/admin/store/${storeId}/orders`,
      icon: ClipboardList,
    },
    {
      name: 'Sync',
      href: `/admin/store/${storeId}/sync`,
      icon: RefreshCw,
    },
    {
      name: 'Settings',
      href: `/admin/store/${storeId}/settings`,
      icon: Settings,
    },
  ] : []

  const superAdminStoreItems = isSuperAdmin && effectiveStoreId ? [
    {
      name: 'Upload Products',
      href: `/admin/store/${effectiveStoreId}/import?type=products`,
      icon: Upload,
    },
    {
      name: 'Upload Variations',
      href: `/admin/store/${effectiveStoreId}/import?type=variations`,
      icon: Layers,
    },
    {
      name: 'Review Products',
      href: `/admin/store/${effectiveStoreId}/products`,
      icon: ShoppingBag,
    },
    {
      name: 'Orders',
      href: `/admin/store/${effectiveStoreId}/orders`,
      icon: ClipboardList,
    },
  ] : []

  const navigationItems = isAdmin && storeId
    ? [...baseNavigationItems.filter(item => item.name === 'Dashboard'), ...adminStoreItems]
    : isSuperAdmin
      ? [
          ...baseNavigationItems.filter(item => item.roles.includes(user.role)),
          ...superAdminStoreItems,
        ]
      : baseNavigationItems.filter(item => item.roles.includes(user.role))

  return (
    <div className="flex h-screen w-64 flex-col bg-white border-r border-gray-200">
      {/* Logo */}
      <div className="flex h-16 items-center px-6 border-b border-gray-200">
        <Link href="/dashboard" className="flex items-center space-x-2">
          <Store className="h-8 w-8 text-green-600" />
          <span className="text-xl font-bold text-gray-900">WooApp</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 py-6 space-y-1">
        {navigationItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-green-50 text-green-600"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.name}</span>
            </Link>
          )
        })}
      </nav>

      {/* User Info & Logout */}
      <div className="border-t border-gray-200 p-4 space-y-4">
        <div className="px-4">
          <p className="text-sm font-medium text-gray-900">{user.name}</p>
          <p className="text-xs text-gray-500 truncate">{user.email}</p>
          <p className="text-xs font-medium text-green-600 mt-1">
            {user.role === 'super_admin' ? 'SUPER ADMIN' : 'ADMIN'}
          </p>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="w-full flex items-center justify-center space-x-2 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
        >
          <LogOut className="h-4 w-4" />
          <span>Logout</span>
        </button>
        <p className="text-xs text-center text-gray-400">
          Multi-Store Catalog Management v1.0.0
        </p>
      </div>
    </div>
  )
}

