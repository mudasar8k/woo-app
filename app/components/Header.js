'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Button } from '@/app/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu'
import { Store, Users, Package, LogOut, User } from 'lucide-react'
import { cn } from '@/app/lib/utils'

export default function Header({ user }) {
  const pathname = usePathname()

  if (!user) {
    return null
  }
  const isActive = (path) => {
    return pathname === path || pathname?.startsWith(path)
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center px-4">
        <div className="mr-4 flex items-center space-x-2">
          <Link href="/dashboard" className="flex items-center space-x-2">
            <Store className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold">WooApp</span>
          </Link>
        </div>

        {user.role === 'super_admin' && (
          <nav className="flex items-center space-x-6 text-sm font-medium ml-6">
            <Link
              href="/super-admin/stores"
              className={cn(
                "flex items-center space-x-2 transition-colors hover:text-foreground/80",
                isActive('/super-admin/stores')
                  ? "text-foreground"
                  : "text-foreground/60"
              )}
            >
              <Store className="h-4 w-4" />
              <span>Stores</span>
            </Link>
            <Link
              href="/super-admin/vendors"
              className={cn(
                "flex items-center space-x-2 transition-colors hover:text-foreground/80",
                isActive('/super-admin/vendors')
                  ? "text-foreground"
                  : "text-foreground/60"
              )}
            >
              <Package className="h-4 w-4" />
              <span>Vendors</span>
            </Link>
            <Link
              href="/super-admin/users"
              className={cn(
                "flex items-center space-x-2 transition-colors hover:text-foreground/80",
                isActive('/super-admin/users')
                  ? "text-foreground"
                  : "text-foreground/60"
              )}
            >
              <Users className="h-4 w-4" />
              <span>Users</span>
            </Link>
          </nav>
        )}

        <div className="flex flex-1 items-center justify-end space-x-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center space-x-2">
                <User className="h-4 w-4" />
                <span className="hidden sm:inline-block">{user.name}</span>
                <span className="hidden sm:inline-block text-muted-foreground">
                  ({user.role === 'super_admin' ? 'Super Admin' : 'Admin'})
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{user.name}</p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {user.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                <span>Log out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

