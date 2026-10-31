import { getIdToken } from "@/lib/auth"
import type { ParseResult } from "@/types"

/**
 * Client of the agenda parser (infra/ai.tf): a separate Lambda function URL outside the VPC that
 * asks Claude on Bedrock for a suggested agenda. It only reads text and returns JSON; saving goes
 * through the main API.
 */

// Set at build time from the AI stack's output; empty = the feature is not deployed.
const parserUrl = () => (import.meta.env.VITE_PARSER_URL ?? "").replace(/\/+$/, "")
export const MAX_PASTE_CHARS = 10_000

export const parserEnabled = () => Boolean(parserUrl())

export type ParseErrorKind =
  "too_long" | "no_agenda" | "busy" | "unauthorized" | "unavailable" | "network" | "aborted"

const MESSAGES: Record<ParseErrorKind, string> = {
  too_long: `The text is too long. Paste at most ${MAX_PASTE_CHARS.toLocaleString()} characters.`,
  no_agenda: "Could not find an agenda in this text. Check it, or type the agenda below.",
  busy: "The AI service is busy right now. Try again in a minute, or type the agenda below.",
  unauthorized: "Your session has expired. Sign in again to use Paste an agenda.",
  unavailable: "The AI service is unavailable. You can type the agenda below.",
  network: "Network error: could not reach the AI service. Check your connection and try again.",
  aborted: "Cancelled.",
}

export class ParseError extends Error {
  readonly kind: ParseErrorKind

  constructor(kind: ParseErrorKind, message = MESSAGES[kind]) {
    super(message)
    this.name = "ParseError"
    this.kind = kind
  }
}

const STATUS_KIND: Record<number, ParseErrorKind> = {
  401: "unauthorized",
  413: "too_long",
  422: "no_agenda",
  429: "busy",
}

/** Today in the user's time zone: their "Monday" is not the Lambda's (UTC) Monday. */
function localToday(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export async function parseAgenda(text: string, signal?: AbortSignal): Promise<ParseResult> {
  if (text.length > MAX_PASTE_CHARS) throw new ParseError("too_long")
  const token = getIdToken()
  let response: Response
  try {
    response = await fetch(parserUrl(), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        text,
        today: localToday(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    })
  } catch {
    if (signal?.aborted) throw new ParseError("aborted")
    throw new ParseError("network")
  }
  if (!response.ok) throw new ParseError(STATUS_KIND[response.status] ?? "unavailable")
  return (await response.json()) as ParseResult
}
