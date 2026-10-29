import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgendaDialog } from "@/components/AgendaDialog"
import { mockFetch, renderWithQuery, sampleMeeting } from "@/test/utils"
import type { ParseResult } from "@/types"

const PARSER_URL = "https://parser.example.on.aws"

const PARSED: ParseResult = {
  agenda: {
    title: "Синк по прайсингу",
    starts_at: null,
    duration_minutes: 45,
    items: [
      { topic: "Нові тарифи Pro", owner: "Олена", minutes: 15 },
      { topic: "Фідбек від клієнтів", owner: "Taras", minutes: null },
    ],
    action_items: [{ task: "Порівняння з конкурентами", owner: "Taras", due: "2026-10-30" }],
    language: "uk",
  },
  model: "anthropic.claude-opus-5-5",
  prompt_version: "agenda-v1",
}

beforeEach(() => vi.stubEnv("VITE_PARSER_URL", PARSER_URL))
afterEach(() => vi.unstubAllEnvs())

function renderDialog(parser: () => { status?: number; body?: unknown }) {
  const fetchMock = mockFetch((url) =>
    url === PARSER_URL ? parser() : { body: { ...sampleMeeting, agenda: PARSED.agenda } },
  )
  renderWithQuery(<AgendaDialog meeting={sampleMeeting} onClose={() => {}} />)
  return fetchMock
}

async function pasteAndParse(text = "Пн 10:00, синк по прайсингу, 45 хв.") {
  await userEvent.type(screen.getByLabelText("Paste an agenda"), text)
  await userEvent.click(screen.getByRole("button", { name: "Parse" }))
}

describe("AgendaDialog", () => {
  it("pre-fills the form, marks suggestions until edited, and saves with the suggestion", async () => {
    const fetchMock = renderDialog(() => ({ body: PARSED }))
    await pasteAndParse()

    const owner = await screen.findByLabelText("Owner of item 1")
    expect(owner).toHaveValue("Олена")
    // topic + owner + minutes of item 1, topic + owner of item 2, task + owner + due of the action
    expect(screen.getAllByText("suggested")).toHaveLength(8)
    expect(screen.getByLabelText("Minutes of item 2")).toHaveValue(null)

    await userEvent.clear(owner)
    await userEvent.type(owner, "Olena K.")
    expect(screen.getAllByText("suggested")).toHaveLength(7)

    await userEvent.click(screen.getByRole("button", { name: "Save agenda" }))
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agenda"))!
    expect(init?.method).toBe("PUT")
    const body = JSON.parse(String(init?.body))
    expect(body.agenda.items[0]).toEqual({
      topic: "Нові тарифи Pro",
      owner: "Olena K.",
      minutes: 15,
    })
    expect(body.ai_suggestion).toEqual({
      ...PARSED,
      input_text: "Пн 10:00, синк по прайсингу, 45 хв.",
    })
  })

  it("sends today and the user's time zone to the parser", async () => {
    const fetchMock = renderDialog(() => ({ body: PARSED }))
    await pasteAndParse()
    await screen.findByLabelText("Owner of item 1")

    const [, init] = fetchMock.mock.calls.find(([url]) => url === PARSER_URL)!
    const body = JSON.parse(String(init?.body))
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it.each([
    [422, "Could not find an agenda in this text"],
    [429, "The AI service is busy right now"],
    [413, "The text is too long"],
    [503, "The AI service is unavailable"],
  ])("explains a %i from the parser", async (status, message) => {
    renderDialog(() => ({ status, body: { error: "x" } }))
    await pasteAndParse()
    expect(await screen.findByRole("alert")).toHaveTextContent(message)
    // The manual form is still there.
    expect(screen.getByLabelText("Topic 1")).toBeInTheDocument()
  })

  it("is a plain agenda form when the parser is not deployed", () => {
    vi.stubEnv("VITE_PARSER_URL", "")
    renderDialog(() => ({ body: PARSED }))
    expect(screen.queryByLabelText("Paste an agenda")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Topic 1")).toBeInTheDocument()
  })
})
