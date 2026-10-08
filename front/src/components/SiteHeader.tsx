import { useQueryClient } from "@tanstack/react-query"
import { CalendarDays, LogIn, LogOut, Plus } from "lucide-react"
import { Link } from "react-router"

import { authEnabled, useSession } from "@/lib/auth"

interface SiteHeaderProps {
  onNewMeeting: () => void
}

export function SiteHeader({ onNewMeeting }: SiteHeaderProps) {
  const { isAuthenticated, email, signIn, signOut } = useSession()
  const queryClient = useQueryClient()

  const handleSignOut = () => {
    queryClient.clear()
    void signOut()
  }

  return (
    <header className="sticky top-0 z-40 bg-brand text-white shadow-[0_0.8px_8px_rgba(0,0,0,0.2)]">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-sm border-2 border-white/90">
            <CalendarDays className="size-5" />
          </span>
          <span className="font-serif text-sm leading-tight">
            Meetings
            <br />
            <span className="text-white/80">Scheduler</span>
          </span>
        </Link>

        <nav className="hidden h-full items-stretch gap-6 text-sm sm:flex">
          <Link
            to="/"
            className="flex items-center border-b-[3px] border-white pt-[3px] font-medium"
          >
            Meetings
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-4">
          {isAuthenticated ? (
            <>
              <button
                type="button"
                onClick={onNewMeeting}
                className="flex items-center gap-1.5 text-sm font-semibold hover:text-white/80"
              >
                <Plus className="size-4" /> New meeting
              </button>
              <span className="h-8 w-px bg-white/30" />
              <span
                className="max-w-40 truncate text-sm text-white/90 sm:max-w-64"
                title={email}
                data-testid="user-email"
              >
                {email}
              </span>
              {authEnabled() && (
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="flex items-center gap-1.5 text-sm text-white/90 hover:text-white"
                  aria-label="Sign out"
                >
                  <LogOut className="size-4" />
                  <span className="hidden md:inline">Sign out</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => void signIn()}
              className="flex items-center gap-1.5 text-sm font-semibold hover:text-white/80"
            >
              <LogIn className="size-4" /> Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
