/**
 * Sign-in with Amazon Cognito's managed login, through react-oidc-context / oidc-client-ts
 * (authorization code flow with PKCE). Cognito's page offers email + password (with sign-up) and
 * Continue with Google; the app only redirects there and gets Cognito tokens back either way. The
 * ID token is sent to our API, which verifies it.
 *
 * Without VITE_COGNITO_CLIENT_ID (local development without AWS) auth is disabled: the app acts as
 * signed in and the backend treats every request as one local user.
 */
import { useAuth } from "react-oidc-context"
import { User, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts"

export interface AuthConfig {
  region: string
  userPoolId: string
  clientId: string
  /** Cognito domain, e.g. meetings-123.auth.us-east-1.amazoncognito.com (for sign-out). */
  domain: string
}

export function authConfig(): AuthConfig {
  const env = import.meta.env
  return {
    region: env.VITE_COGNITO_REGION || "us-east-1",
    userPoolId: env.VITE_COGNITO_USER_POOL_ID ?? "",
    clientId: env.VITE_COGNITO_CLIENT_ID ?? "",
    domain: env.VITE_COGNITO_DOMAIN ?? "",
  }
}

export const authEnabled = () => Boolean(authConfig().clientId && authConfig().userPoolId)

/** Must match the app client's CallbackURLs exactly (the Makefile registers the same path). */
export const callbackUrl = () => `${window.location.origin}/auth/callback`
/** Must match the app client's LogoutURLs exactly. */
export const logoutRedirectUrl = () => `${window.location.origin}/`

function authority(): string {
  const { region, userPoolId } = authConfig()
  // Auth disabled: never contacted, but the provider still needs a value.
  return userPoolId
    ? `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`
    : "https://localhost.invalid"
}

export function oidcSettings(): UserManagerSettings {
  return {
    authority: authority(),
    client_id: authConfig().clientId || "local",
    redirect_uri: callbackUrl(),
    post_logout_redirect_uri: logoutRedirectUrl(),
    response_type: "code",
    scope: "openid email profile",
    // localStorage, so a reload or a new tab stays signed in.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  }
}

/** The stored session, for code outside React (the API client). */
export function storedUser(): User | null {
  const raw = localStorage.getItem(`oidc.user:${authority()}:${authConfig().clientId}`)
  return raw ? User.fromStorageString(raw) : null
}

/** A valid ID token for the API; null when signed out or expired. */
export function getIdToken(): string | null {
  const user = storedUser()
  return user && !user.expired ? (user.id_token ?? null) : null
}

/** Cognito has no OIDC end-session endpoint; its own /logout ends the managed-login session. */
export function cognitoLogoutUrl(): string {
  const params = new URLSearchParams({
    client_id: authConfig().clientId,
    logout_uri: logoutRedirectUrl(),
  })
  return `https://${authConfig().domain}/logout?${params}`
}

export const LOCAL_EMAIL = "dev@localhost"

/** Who is signed in, and the actions to change it. */
export function useSession() {
  const auth = useAuth()
  if (!authEnabled()) {
    return {
      isLoading: false,
      isAuthenticated: true,
      email: LOCAL_EMAIL,
      error: undefined,
      signIn: async () => {},
      signInWithGoogle: async () => {},
      signOut: async () => {},
    }
  }
  return {
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
    email: auth.user?.profile.email,
    error: auth.error,
    signIn: () => auth.signinRedirect(),
    // Skips Cognito's page and goes straight to Google.
    signInWithGoogle: () =>
      auth.signinRedirect({ extraQueryParams: { identity_provider: "Google" } }),
    signOut: async () => {
      await auth.removeUser()
      window.location.assign(cognitoLogoutUrl())
    },
  }
}
