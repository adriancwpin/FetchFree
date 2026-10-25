import { useMemo } from 'react'
import { useTransactions } from '@/hooks/useBank'
import { formatAmount, monthLabel } from '@/lib/format'
import { addDays, summarizeByMonth, type MonthSummary } from '@/lib/summary'
import { cn } from '@/lib/utils'

const CHART_HEIGHT_PX = 160

// Signed amount, e.g. +€11.71 / −€538.05 / €0.00, plus its colour class.
function signedAmount(value: number, currency: string): { text: string; className: string } {
  const text = formatAmount(String(Math.abs(value)), currency)
  if (value > 0) return { text: `+${text}`, className: 'text-emerald-600' }
  if (value < 0) return { text: `−${text}`, className: 'text-destructive' }
  return { text, className: 'text-muted-foreground' }
}

function countOf(count: number): string {
  return `${count} transaction${count === 1 ? ' is' : 's are'}`
}

function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function formatCompact(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  } catch {
    return String(Math.round(value))
  }
}

// Rounds the axis max up to a clean 1/2/5 × 10^n step.
function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((multiple) => multiple * magnitude >= value) ?? 10
  return step * magnitude
}

export function SpendingSummary({
  accountUid,
  accountCurrency,
}: {
  accountUid: string
  accountCurrency: string | null
}) {
  const transactions = useTransactions(accountUid)
  // Recomputed only when the data changes, not on every click in the category breakdown.
  const summary = useMemo(
    () => (transactions.data ? summarizeByMonth(transactions.data, accountCurrency) : null),
    [transactions.data, accountCurrency],
  )

  // Loading/error and "no transactions at all" are shown by TransactionsTable below.
  if (!transactions.data || !summary || transactions.data.transactions.length === 0) return null

  const { currency } = summary
  const since = longDate(transactions.data.dateFrom)
  // Why some transactions in the table aren't in these totals.
  const exclusionNotes = [
    summary.notYetSettled > 0 &&
      `${countOf(summary.notYetSettled)} not settled yet (pending, scheduled or on hold) and will be counted once booked.`,
    summary.notCounted > 0 &&
      `${countOf(summary.notCounted)} cancelled, rejected or informational, so never counted.`,
    summary.skipped > 0 && currency && `${countOf(summary.skipped)} in currencies other than ${currency}, not included.`,
  ].filter((note): note is string => Boolean(note))

  if (!currency || (summary.totalIn === 0 && summary.totalOut === 0)) {
    // Say why the summary is empty when the table below does list transactions.
    return (
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>Nothing to summarise since {since}.</p>
        {exclusionNotes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    )
  }

  const axisMax = niceCeiling(Math.max(...summary.months.flatMap((m) => [m.moneyIn, m.moneyOut])))
  const net = signedAmount(summary.net, currency)
  const partialMonth = summary.months.find((month) => month.partialFrom)

  return (
    <section className="flex flex-col gap-4" aria-label={`Money in and out since ${since}`}>
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Money in" swatch="bg-series-in" value={formatAmount(String(summary.totalIn), currency)} />
        <Stat label="Money out" swatch="bg-series-out" value={formatAmount(String(summary.totalOut), currency)} />
        <Stat
          label="Net"
          value={net.text}
          valueClassName={net.className}
        />
      </dl>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Since {since}</p>
          <ul className="flex gap-3 text-xs text-muted-foreground">
            <LegendItem swatch="bg-series-in" label="In" />
            <LegendItem swatch="bg-series-out" label="Out" />
          </ul>
        </div>

        <div className="flex gap-2" aria-hidden="true">
          {/* Y axis: 0, half and max, compact. */}
          <div
            className="flex flex-col justify-between text-right text-[0.7rem] text-muted-foreground tabular-nums"
            style={{ height: CHART_HEIGHT_PX }}
          >
            <span className="-translate-y-1/2">{formatCompact(axisMax, currency)}</span>
            <span>{formatCompact(axisMax / 2, currency)}</span>
            <span className="translate-y-1/2">{formatCompact(0, currency)}</span>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="relative" style={{ height: CHART_HEIGHT_PX }}>
              {/* Hairline gridlines at max, half and the baseline. */}
              {[0, 50, 100].map((top) => (
                <div key={top} className="absolute inset-x-0 border-t border-border" style={{ top: `${top}%` }} />
              ))}
              <div className="absolute inset-0 flex">
                {summary.months.map((month, index) => (
                  <MonthColumn
                    key={month.month}
                    month={month}
                    axisMax={axisMax}
                    currency={currency}
                    tooltipAlign={
                      index === 0 ? 'start' : index === summary.months.length - 1 ? 'end' : 'center'
                    }
                  />
                ))}
              </div>
            </div>
            <div className="flex text-[0.7rem] text-muted-foreground">
              {summary.months.map((month) => (
                <span key={month.month} className="flex-1 text-center">
                  {monthLabel(month.month)}
                  {month.partialFrom && '*'}
                </span>
              ))}
            </div>
          </div>
        </div>

        {partialMonth?.partialFrom && (
          <p className="text-xs text-muted-foreground">
            * {monthLabel(partialMonth.month, 'long')} only includes transactions from{' '}
            {longDate(partialMonth.partialFrom)}; your bank didn’t allow a longer history.
          </p>
        )}
        {exclusionNotes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
        {transactions.data.gap && (
          <p className="text-xs text-muted-foreground">
            Some transactions from {longDate(transactions.data.gap.from)} to{' '}
            {/* `to` is the first day after the gap. */}
            {longDate(addDays(transactions.data.gap.to, -1))} may be missing: your bank no longer returns that
            period, so those months may look lower than they really were.
          </p>
        )}
        {transactions.data.truncated && (
          <p className="text-xs text-muted-foreground">
            This account has too many transactions to load in full, so the earliest months may be incomplete.
          </p>
        )}
      </div>

      {/* Screen-reader version of the chart. */}
      <table className="sr-only">
        <caption>Money in and out by month ({currency})</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {summary.months.map((month) => (
            <tr key={month.month}>
              <th scope="row">
                {monthLabel(month.month, 'long')}
                {month.partialFrom && ` (from ${longDate(month.partialFrom)})`}
              </th>
              <td>{formatAmount(String(month.moneyIn), currency)}</td>
              <td>{formatAmount(String(month.moneyOut), currency)}</td>
              <td>{signedAmount(month.net, currency).text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Stat({
  label,
  value,
  swatch,
  valueClassName,
}: {
  label: string
  value: string
  swatch?: string
  valueClassName?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {swatch && <span className={cn('size-2 shrink-0 rounded-full', swatch)} />}
        {label}
      </dt>
      <dd className={cn('truncate text-sm font-semibold tabular-nums sm:text-base', valueClassName)}>{value}</dd>
    </div>
  )
}

function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn('size-2 rounded-[2px]', swatch)} />
      {label}
    </li>
  )
}

// Edge columns anchor their tooltip inward so it isn't cut off at the card edge on narrow screens.
const TOOLTIP_ALIGN_CLASSES = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
}

function MonthColumn({
  month,
  axisMax,
  currency,
  tooltipAlign,
}: {
  month: MonthSummary
  axisMax: number
  currency: string
  tooltipAlign: keyof typeof TOOLTIP_ALIGN_CLASSES
}) {
  const height = (value: number) => `${(value / axisMax) * 100}%`
  // A partial month's bars are faded so a short period doesn't read as a drop in spending.
  const barClass = cn('w-full max-w-6 rounded-t-[4px]', month.partialFrom && 'opacity-50')

  return (
    // The whole month column is the hover target, wider than the bars themselves.
    <div className="group relative flex flex-1 items-end justify-center gap-[2px] px-1 hover:bg-muted/50">
      <div className={cn(barClass, 'bg-series-in')} style={{ height: height(month.moneyIn) }} />
      <div className={cn(barClass, 'bg-series-out')} style={{ height: height(month.moneyOut) }} />

      <div
        className={cn(
          'pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block',
          TOOLTIP_ALIGN_CLASSES[tooltipAlign],
        )}
      >
        <p className="mb-1 font-medium">
          {monthLabel(month.month, 'long')}
          {month.partialFrom && ` (from ${longDate(month.partialFrom)})`}
        </p>
        <TooltipRow swatch="bg-series-in" label="In" value={formatAmount(String(month.moneyIn), currency)} />
        <TooltipRow swatch="bg-series-out" label="Out" value={formatAmount(String(month.moneyOut), currency)} />
        <p className="mt-1 border-t pt-1 text-muted-foreground tabular-nums">
          Net {signedAmount(month.net, currency).text}
        </p>
      </div>
    </div>
  )
}

function TooltipRow({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <p className="flex items-center justify-between gap-4 tabular-nums">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className={cn('size-2 rounded-[2px]', swatch)} />
        {label}
      </span>
      {value}
    </p>
  )
}
