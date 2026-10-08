import { useEffect, useRef } from "react"
import { LoaderCircle } from "lucide-react"
import { Navigate } from "react-router"

import { AuthLayout } from "@/components/auth/AuthLayout"
import { authEnabled, useSession } from "@/lib/auth"

/**
 * /login/: sends the browser straight to Cognito's managed login (email + password with sign-up,
 * and Continue with Google). Sign-in has to start here, not on a copied Cognito URL: the library
 * stores the state and PKCE verifier that the callback checks.
 */
export function LoginPage() {
  const { signIn, error } = useSession()
  // StrictMode runs effects twice in development; redirect once.
  const started = useRef(false)

  useEffect(() => {
    if (!authEnabled() || started.current) return
    started.current = true
    void signIn()
  }, [signIn])

  if (!authEnabled()) return <Navigate to="/" replace />

  return (
    <AuthLayout>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not open the sign-in page: {error.message}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" /> Redirecting to sign in…
        </p>
      )}
    </AuthLayout>
  )
}
