import { type ComponentProps, useEffect, useRef, useState } from "react"
import { Loader2, Plus, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useSaveAgenda } from "@/hooks/useMeetings"
import { ApiError } from "@/lib/api"
import { MAX_PASTE_CHARS, ParseError, parseAgenda, parserEnabled } from "@/lib/parser"
import { cn } from "@/lib/utils"
import type { ActionItem, Agenda, AgendaItem, Meeting, ParseResult } from "@/types"

/**
 * The agenda of one meeting: typed by hand, or pre-filled from pasted text by the agenda parser.
 * The model only suggests: every field it filled carries a "suggested" badge until the user
 * touches it, and Save goes through the main API like a typed agenda.
 */

interface ItemRow {
  key: number
  topic: string
  owner: string
  minutes: string
  suggested: Set<string>
}

interface ActionRow {
  key: number
  task: string
  owner: string
  due: string
  suggested: Set<string>
}

let nextKey = 0
const newKey = () => ++nextKey

function itemRow(item?: AgendaItem, suggested = false): ItemRow {
  const filled = new Set<string>()
  if (suggested && item) {
    if (item.topic) filled.add("topic")
    if (item.owner) filled.add("owner")
    if (item.minutes) filled.add("minutes")
  }
  return {
    key: newKey(),
    topic: item?.topic ?? "",
    owner: item?.owner ?? "",
    minutes: item?.minutes ? String(item.minutes) : "",
    suggested: filled,
  }
}

function actionRow(action?: ActionItem, suggested = false): ActionRow {
  const filled = new Set<string>()
  if (suggested && action) {
    if (action.task) filled.add("task")
    if (action.owner) filled.add("owner")
    if (action.due) filled.add("due")
  }
  return {
    key: newKey(),
    task: action?.task ?? "",
    owner: action?.owner ?? "",
    due: action?.due ?? "",
    suggested: filled,
  }
}

/** Editing a field takes it from the model's suggestion to the user's value. */
function edit<T extends { suggested: Set<string> }>(
  row: T,
  field: keyof T & string,
  value: string,
): T {
  const suggested = new Set(row.suggested)
  suggested.delete(field)
  return { ...row, [field]: value, suggested }
}

/** An input that shows a "suggested" badge (an icon only when `compact`) while the model's value stands. */
function SuggestedInput({
  suggested,
  compact = false,
  className,
  ...props
}: ComponentProps<typeof Input> & { suggested: boolean; compact?: boolean }) {
  return (
    <div className="relative">
      <Input
        className={cn(
          suggested && "border-brand/60 bg-brand/5",
          suggested && (compact ? "pr-10" : "pr-24"),
          className,
        )}
        {...props}
      />
      {suggested && (
        <Badge
          variant="secondary"
          title="Suggested by AI: check it"
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2",
            compact ? "right-7 px-1" : "right-1.5",
          )}
        >
          <Sparkles />
          <span className={cn(compact && "sr-only")}>suggested</span>
        </Badge>
      )}
    </div>
  )
}

function toAgenda(items: ItemRow[], actions: ActionRow[]): Agenda | string {
  const filledItems = items.filter((r) => r.topic.trim() || r.owner.trim() || r.minutes.trim())
  if (filledItems.length === 0) return "Add at least one agenda item."
  for (const r of filledItems) {
    if (!r.topic.trim()) return "Every agenda item needs a topic."
    const minutes = Number(r.minutes)
    if (r.minutes && (!Number.isInteger(minutes) || minutes < 1 || minutes > 480))
      return "Minutes must be a whole number from 1 to 480."
  }
  const filledActions = actions.filter((r) => r.task.trim() || r.owner.trim() || r.due)
  for (const r of filledActions) if (!r.task.trim()) return "Every action item needs a task."
  return {
    items: filledItems.map((r) => ({
      topic: r.topic.trim(),
      owner: r.owner.trim() || null,
      minutes: r.minutes ? Number(r.minutes) : null,
    })),
    action_items: filledActions.map((r) => ({
      task: r.task.trim(),
      owner: r.owner.trim() || null,
      due: r.due || null,
    })),
  }
}

function formatSuggestedStart(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

interface AgendaDialogProps {
  /** The meeting whose agenda is edited; null = closed. */
  meeting: Meeting | null
  onClose: () => void
}

export function AgendaDialog({ meeting, onClose }: AgendaDialogProps) {
  const saveAgenda = useSaveAgenda()
  const [pasted, setPasted] = useState("")
  const [parsing, setParsing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [parseError, setParseError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<(ParseResult & { input_text: string }) | null>(null)
  // Rendered with key={meeting.id}, so a new meeting starts from fresh state.
  const [items, setItems] = useState<ItemRow[]>(
    () => meeting?.agenda?.items.map((i) => itemRow(i)) ?? [itemRow()],
  )
  const [actions, setActions] = useState<ActionRow[]>(
    () => meeting?.agenda?.action_items.map((a) => actionRow(a)) ?? [],
  )
  const [formError, setFormError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // A ticking counter, so a long parse never looks like a frozen page.
  useEffect(() => {
    if (!parsing) return
    const id = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [parsing])

  const cancelParse = () => abortRef.current?.abort()

  const close = () => {
    cancelParse()
    onClose()
  }

  const parse = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setElapsed(0)
    setParsing(true)
    setParseError(null)
    try {
      const result = await parseAgenda(pasted, controller.signal)
      setSuggestion({ ...result, input_text: pasted })
      setItems(result.agenda.items.map((i) => itemRow(i, true)))
      setActions(result.agenda.action_items.map((a) => actionRow(a, true)))
      setFormError(null)
    } catch (error) {
      if (error instanceof ParseError && error.kind === "aborted") return
      setParseError(error instanceof Error ? error.message : "Could not parse the text")
    } finally {
      setParsing(false)
      abortRef.current = null
    }
  }

  const save = async () => {
    if (!meeting) return
    const agenda = toAgenda(items, actions)
    if (typeof agenda === "string") {
      setFormError(agenda)
      return
    }
    setFormError(null)
    try {
      await saveAgenda.mutateAsync({
        id: meeting.id,
        data: { agenda, ai_suggestion: suggestion },
      })
      toast.success("Agenda saved")
      onClose()
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : "Could not save the agenda, try again",
      )
    }
  }

  const tooLong = pasted.length > MAX_PASTE_CHARS
  const detected = suggestion?.agenda

  return (
    <Dialog open={meeting !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agenda{meeting ? `: ${meeting.title}` : ""}</DialogTitle>
          <DialogDescription>
            {parserEnabled()
              ? "Paste an email, a chat message or notes and let AI pre-fill the agenda, or type it yourself. Check every suggestion before saving."
              : "What will this meeting cover?"}
          </DialogDescription>
        </DialogHeader>

        {parserEnabled() && (
          <section className="space-y-2 rounded-sm border bg-muted/40 p-3">
            <Label htmlFor="paste-agenda">Paste an agenda</Label>
            <Textarea
              id="paste-agenda"
              rows={4}
              className="max-h-48 bg-background"
              placeholder="Пн 10:00, синк по прайсингу, 45 хв. 1) нові тарифи Pro — Олена, 15 хв 2) …"
              value={pasted}
              disabled={parsing}
              onChange={(e) => setPasted(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              {parsing ? (
                <>
                  <p
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    Reading the agenda… {elapsed} s
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={cancelParse}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={parse}
                  disabled={!pasted.trim() || tooLong}
                >
                  <Sparkles /> Parse
                </Button>
              )}
              <span
                className={cn(
                  "ml-auto text-xs text-muted-foreground",
                  tooLong && "font-medium text-destructive",
                )}
              >
                {pasted.length.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()}
              </span>
            </div>
            {parseError && (
              <p role="alert" className="text-sm text-destructive">
                {parseError}
              </p>
            )}
            {detected && (detected.title || detected.starts_at || detected.duration_minutes) && (
              <p className="text-xs text-muted-foreground">
                Also found in the text:{" "}
                {[
                  detected.title && `“${detected.title}”`,
                  detected.starts_at && formatSuggestedStart(detected.starts_at),
                  detected.duration_minutes && `${detected.duration_minutes} min`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                . Edit the meeting to change its title or time.
              </p>
            )}
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Agenda items</h3>
          <div className="hidden grid-cols-[1fr_10rem_6rem_2.25rem] gap-2 text-xs text-muted-foreground sm:grid">
            <span>Topic</span>
            <span>Owner</span>
            <span>Minutes</span>
          </div>
          {items.map((row, i) => (
            <div
              key={row.key}
              className="grid grid-cols-[1fr_2.25rem] gap-2 sm:grid-cols-[1fr_10rem_6rem_2.25rem]"
            >
              <SuggestedInput
                aria-label={`Topic ${i + 1}`}
                placeholder="Topic"
                value={row.topic}
                suggested={row.suggested.has("topic")}
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "topic", e.target.value) : r)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="sm:order-last"
                aria-label={`Remove item ${i + 1}`}
                onClick={() => setItems((rows) => rows.filter((r) => r.key !== row.key))}
              >
                <X />
              </Button>
              <SuggestedInput
                aria-label={`Owner of item ${i + 1}`}
                placeholder="Owner"
                value={row.owner}
                suggested={row.suggested.has("owner")}
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "owner", e.target.value) : r)),
                  )
                }
              />
              <SuggestedInput
                aria-label={`Minutes of item ${i + 1}`}
                placeholder="min"
                type="number"
                min={1}
                max={480}
                value={row.minutes}
                suggested={row.suggested.has("minutes")}
                compact
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "minutes", e.target.value) : r)),
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setItems((rows) => [...rows, itemRow()])}
          >
            <Plus /> Add item
          </Button>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Action items</h3>
          {actions.length === 0 && (
            <p className="text-sm text-muted-foreground">No action items.</p>
          )}
          {actions.map((row, i) => (
            <div
              key={row.key}
              className="grid grid-cols-[1fr_2.25rem] gap-2 sm:grid-cols-[1fr_10rem_9rem_2.25rem]"
            >
              <SuggestedInput
                aria-label={`Task ${i + 1}`}
                placeholder="Task"
                value={row.task}
                suggested={row.suggested.has("task")}
                onChange={(e) =>
                  setActions((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "task", e.target.value) : r)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="sm:order-last"
                aria-label={`Remove action ${i + 1}`}
                onClick={() => setActions((rows) => rows.filter((r) => r.key !== row.key))}
              >
                <X />
              </Button>
              <SuggestedInput
                aria-label={`Owner of action ${i + 1}`}
                placeholder="Owner"
                value={row.owner}
                suggested={row.suggested.has("owner")}
                onChange={(e) =>
                  setActions((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "owner", e.target.value) : r)),
                  )
                }
              />
              <SuggestedInput
                aria-label={`Due date of action ${i + 1}`}
                type="date"
                value={row.due}
                suggested={row.suggested.has("due")}
                compact
                onChange={(e) =>
                  setActions((rows) =>
                    rows.map((r) => (r.key === row.key ? edit(r, "due", e.target.value) : r)),
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setActions((rows) => [...rows, actionRow()])}
          >
            <Plus /> Add action item
          </Button>
        </section>

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        <DialogFooter>
          {suggestion && (
            <p className="mr-auto self-center text-xs text-muted-foreground">
              Suggested by {suggestion.model.replace(/^anthropic\./, "")} ·{" "}
              {suggestion.prompt_version}
            </p>
          )}
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saveAgenda.isPending || parsing}>
            {saveAgenda.isPending ? "Saving…" : "Save agenda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
