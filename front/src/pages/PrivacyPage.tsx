import { Link } from "react-router"

/** Privacy policy; Google requires its URL before the OAuth app can be published. */
export function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-relaxed text-foreground sm:px-6">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-4">
        Meetings Scheduler is a student project. When you sign in, with an email and password or
        with Google, we receive your email address and name from Amazon Cognito. We use them only to
        show who is signed in and to keep your meetings separate from other users&apos; meetings.
      </p>
      <p className="mt-3">
        Your account is stored in Amazon Cognito and your meetings in a database on Amazon Web
        Services (region us-east-1). We do not share your data with anyone and do not use it for
        advertising. Google sign-in requests only your basic profile and email address.
      </p>
      <p className="mt-3">
        To have your account and meetings deleted, contact the site owner by email.
      </p>
      <Link to="/" className="mt-6 inline-block font-medium text-primary hover:underline">
        Back to the site
      </Link>
    </main>
  )
}
