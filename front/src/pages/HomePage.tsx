import { useState } from "react"
import { toast } from "sonner"

import { GoogleButton } from "@/components/auth/GoogleButton"
import { BackToTop } from "@/components/BackToTop"
import { DeleteMeetingDialog } from "@/components/DeleteMeetingDialog"
import { MeetingFormDialog } from "@/components/MeetingFormDialog"
import { MeetingsCalendar } from "@/components/MeetingsCalendar"
import { SiteFooter } from "@/components/SiteFooter"
import { SiteHeader } from "@/components/SiteHeader"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useDeleteMeeting, useMeetings } from "@/hooks/useMeetings"
import { useSession } from "@/lib/auth"
import type { Meeting } from "@/types"

export function HomePage() {
  const session = useSession()
  const {
    data: meetings,
    isPending,
    isError,
    error,
    refetch,
  } = useMeetings(session.isAuthenticated)
  const deleteMeeting = useDeleteMeeting()
  const [formOpen, setFormOpen] = useState(false)
  const [formStart, setFormStart] = useState<Date | undefined>()
  const [editing, setEditing] = useState<Meeting | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Meeting | null>(null)

  const openForm = (start?: Date) => {
    setEditing(null)
    setFormStart(start)
    setFormOpen(true)
  }

  const openEdit = (meeting: Meeting) => {
    setEditing(meeting)
    setFormOpen(true)
  }

  const confirmDelete = (meeting: Meeting) => {
    setPendingDelete(null)
    deleteMeeting.mutate(meeting.id, {
      onSuccess: () => toast.success("Meeting deleted"),
      onError: (err) => toast.error(`Could not delete meeting: ${err.message}`),
    })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader onNewMeeting={() => openForm()} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
        <section className="rounded-sm border bg-card p-3 sm:p-4">
          <h1 className="sr-only">Meetings</h1>

          {!session.isAuthenticated ? (
            session.isLoading ? (
              <Skeleton className="h-[480px] w-full" aria-label="Loading" />
            ) : (
              <div className="mx-auto max-w-sm py-16 text-center">
                <h2 className="text-xl font-semibold text-foreground">Sign in</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Sign in to see your meetings.
                </p>
                <Button className="mt-6 h-10 w-full" onClick={() => void session.signIn()}>
                  Sign in with email
                </Button>
                <div className="mt-3">
                  <GoogleButton label="Continue with Google" />
                </div>
              </div>
            )
          ) : isPending ? (
            <div className="space-y-2" aria-label="Loading meetings">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-[480px] w-full" />
            </div>
          ) : isError ? (
            <div
              role="alert"
              className="rounded-sm border border-destructive/50 p-4 text-destructive"
            >
              <p className="font-medium">Could not load meetings</p>
              <p className="text-sm">{error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <MeetingsCalendar
              meetings={meetings}
              onEdit={openEdit}
              onDelete={setPendingDelete}
              onCreateAt={openForm}
            />
          )}
        </section>
      </main>

      <SiteFooter />
      <BackToTop />

      <MeetingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initialStart={formStart}
        meeting={editing}
      />
      <DeleteMeetingDialog
        meeting={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
