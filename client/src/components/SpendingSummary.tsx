import { useTransactions } from '@/hooks/useBank'
import { formatAmount } from '@/lib/format'
import { summarizeByMonth, SUMMARY_MONTHS, type MonthSummary } from '@/lib/summary'
import { cn } from '@/lib/utils'

const CHART_HEIGHT_PX = 160

function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [year, monthIndex] = month.split('-').map(Number)
  return new Date(year ?? 0, (monthIndex ?? 1) - 1, 1).toLocaleString(undefined, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  })
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

export function SpendingSummary({ accountUid }: { accountUid: string }) {
  const transactions = useTransactions(accountUid)

  // Loading and error states are shown by TransactionsTable, which reads the same query.
  if (!transactions.data) return null

  const summary = summarizeByMonth(transactions.data)
  const { currency } = summary

  if (!currency || (summary.totalIn === 0 && summary.totalOut === 0)) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity in the last {SUMMARY_MONTHS} months.
      </p>
    )
  }

  const axisMax = niceCeiling(Math.max(...summary.months.flatMap((m) => [m.moneyIn, m.moneyOut])))

  return (
    <section className="flex flex-col gap-4" aria-label={`Money in and out, last ${SUMMARY_MONTHS} months`}>
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Money in" swatch="bg-series-in" value={formatAmount(String(summary.totalIn), currency)} />
        <Stat label="Money out" swatch="bg-series-out" value={formatAmount(String(summary.totalOut), currency)} />
        <Stat
          label="Net"
          value={`${summary.net >= 0 ? '+' : '−'}${formatAmount(String(Math.abs(summary.net)), currency)}`}
          valueClassName={summary.net >= 0 ? 'text-emerald-600' : 'text-destructive'}
        />
      </dl>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Last {SUMMARY_MONTHS} months</p>
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
                {summary.months.map((month) => (
                  <MonthColumn key={month.month} month={month} axisMax={axisMax} currency={currency} />
                ))}
              </div>
            </div>
            <div className="flex text-[0.7rem] text-muted-foreground">
              {summary.months.map((month) => (
                <span key={month.month} className="flex-1 text-center">
                  {monthLabel(month.month)}
                </span>
              ))}
            </div>
          </div>
        </div>

        {summary.skipped > 0 && (
          <p className="text-xs text-muted-foreground">
            {summary.skipped} transaction{summary.skipped === 1 ? '' : 's'} in other currencies not included.
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
              <th scope="row">{monthLabel(month.month, 'long')}</th>
              <td>{formatAmount(String(month.moneyIn), currency)}</td>
              <td>{formatAmount(String(month.moneyOut), currency)}</td>
              <td>{formatAmount(String(month.net), currency)}</td>
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

function MonthColumn({ month, axisMax, currency }: { month: MonthSummary; axisMax: number; currency: string }) {
  const height = (value: number) => `${(value / axisMax) * 100}%`

  return (
    // The whole month column is the hover target, wider than the bars themselves.
    <div className="group relative flex flex-1 items-end justify-center gap-[2px] px-1 hover:bg-muted/50">
      <div className="w-full max-w-6 rounded-t-[4px] bg-series-in" style={{ height: height(month.moneyIn) }} />
      <div className="w-full max-w-6 rounded-t-[4px] bg-series-out" style={{ height: height(month.moneyOut) }} />

      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block">
        <p className="mb-1 font-medium">{monthLabel(month.month, 'long')}</p>
        <TooltipRow swatch="bg-series-in" label="In" value={formatAmount(String(month.moneyIn), currency)} />
        <TooltipRow swatch="bg-series-out" label="Out" value={formatAmount(String(month.moneyOut), currency)} />
        <p className="mt-1 border-t pt-1 text-muted-foreground tabular-nums">
          Net {month.net >= 0 ? '+' : '−'}
          {formatAmount(String(Math.abs(month.net)), currency)}
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
