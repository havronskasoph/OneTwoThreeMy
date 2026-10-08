import { CalendarDays } from "lucide-react"

const COLUMNS = [
  {
    title: "Meetings",
    links: [{ label: "All meetings", href: "/" }],
  },
]

export function SiteFooter() {
  return (
    <footer className="mt-auto text-white">
      <div className="bg-footer">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <span className="flex size-14 items-center justify-center rounded-sm border-2 border-white/90">
                <CalendarDays className="size-7" />
              </span>
              <span className="font-serif text-lg leading-tight">
                Meetings
                <br />
                Scheduler
              </span>
            </div>
          </div>
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="mb-4 text-base font-bold">{column.title}</h2>
              <ul className="space-y-2 text-sm">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className="hover:underline">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-footer-bottom">
        <p className="mx-auto max-w-7xl px-4 py-3 text-sm sm:px-6">
          © {new Date().getFullYear()} Meetings Scheduler. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
