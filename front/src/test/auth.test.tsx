import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { User, UserManager } from "oidc-client-ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import App from "@/App"
import { api } from "@/lib/api"
import { cognitoLogoutUrl } from "@/lib/auth"
import { mockFetch, renderWithQuery } from "@/test/utils"

const POOL = "us-east-1_TEST"
const CLIENT = "client-123"
const DOMAIN = "meetings.auth.us-east-1.amazoncognito.com"
const AUTHORITY = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`

/** A session as oidc-client-ts stores it after Cognito redirects back. */
function storeUser(email = "anna@example.com") {
  const user = new User({
    id_token: "id-token",
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { sub: "sub-1", email, iss: AUTHORITY, aud: CLIENT, exp: 0, iat: 0 },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  localStorage.setItem(`oidc.user:${AUTHORITY}:${CLIENT}`, user.toStorageString())
}

describe("with auth disabled (local development)", () => {
  it("acts as one local user", async () => {
    mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/")
    expect(await screen.findByTestId("user-email")).toHaveTextContent("dev@localhost")
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument()
  })
})

describe("with Cognito configured", () => {
  let signinRedirect: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv("VITE_COGNITO_REGION", "us-east-1")
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", POOL)
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", CLIENT)
    vi.stubEnv("VITE_COGNITO_DOMAIN", DOMAIN)
    signinRedirect = vi.spyOn(UserManager.prototype, "signinRedirect").mockResolvedValue()
  })

  afterEach(() => window.history.replaceState(null, "", "/"))

  it("shows a Sign in button in the header when signed out", async () => {
    mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/")
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }))
    expect(signinRedirect).toHaveBeenCalledTimes(1)
  })

  it("/login redirects to Cognito's managed login as soon as it loads", async () => {
    mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/login")
    await waitFor(() => expect(signinRedirect).toHaveBeenCalledTimes(1))
    expect(screen.getByText("Redirecting to sign in…")).toBeInTheDocument()
  })

  it("can skip Cognito's page and go straight to Google", async () => {
    mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/")
    await userEvent.click(await screen.findByRole("button", { name: "Continue with Google" }))
    expect(signinRedirect).toHaveBeenCalledWith({
      extraQueryParams: { identity_provider: "Google" },
    })
  })

  it("shows the signed-in email and sends the ID token to the API", async () => {
    storeUser()
    const fetchMock = mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/")
    expect(await screen.findByTestId("user-email")).toHaveTextContent("anna@example.com")
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument()

    await api.listMeetings()
    const apiCall = fetchMock.mock.calls.find(([url]) => url === "/api/meetings")
    expect((apiCall?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer id-token")
  })

  it("signs out locally and at Cognito", async () => {
    storeUser()
    mockFetch(() => ({ body: [] }))
    renderWithQuery(<App />, "/")
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }))
    await waitFor(() => expect(localStorage.getItem(`oidc.user:${AUTHORITY}:${CLIENT}`)).toBeNull())
    expect(cognitoLogoutUrl()).toBe(
      `https://${DOMAIN}/logout?client_id=${CLIENT}&logout_uri=${encodeURIComponent(`${window.location.origin}/`)}`,
    )
  })

  it("rejects a callback that did not start in this app", async () => {
    mockFetch(() => ({ body: {} }))
    window.history.replaceState(null, "", "/auth/callback?code=abc&state=forged")
    renderWithQuery(<App />, "/auth/callback?code=abc&state=forged")
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in failed")
  })
})
