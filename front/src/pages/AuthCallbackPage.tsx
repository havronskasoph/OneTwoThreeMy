import { LoaderCircle } from "lucide-react"
import { Link, Navigate, useSearchParams } from "react-router"

import { AuthLayout } from "@/components/auth/AuthLayout"
import { useSession } from "@/lib/auth"

/**
 * Where Cognito sends the browser back with ?code=…&state=…. The AuthProvider exchanges the code
 * for tokens (checking the state and PKCE verifier saved by /login/); this page waits, then goes
 * home.
 */
export function AuthCallbackPage() {
  const { isLoading, isAuthenticated, error } = useSession()
  const [params] = useSearchParams()
  // Cognito came back without a code: an error, or the user cancelled.
  const redirectError = params.get("code") ? null : (params.get("error_description") ?? null)
  const message = redirectError ?? error?.message

  if (message) {
    return (
      <AuthLayout>
        <div role="alert">
          <h1 className="text-2xl font-semibold text-foreground">Sign-in failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{message}</p>
          <Link
            to="/login"
            className="mt-6 inline-block font-medium text-primary underline-offset-4 hover:underline"
          >
            Try again
          </Link>
        </div>
      </AuthLayout>
    )
  }
  if (isAuthenticated || !isLoading) return <Navigate to="/" replace />

  return (
    <AuthLayout>
      <p className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" /> Signing you in…
      </p>
    </AuthLayout>
  )
}
