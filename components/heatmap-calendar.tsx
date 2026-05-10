"use client"

import { useMemo } from "react"

interface HeatmapCalendarProps {
  /** The month key in "YYYY-MM" format, e.g., "2026-05" */
  monthKey: string
  /** Record of date strings ("YYYY-MM-DD") to their totals */
  dayTotals: Record<string, number>
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function getHeatmapColor(value: number, maxValue: number): string {
  if (value === 0) return "bg-slate-800"
  const normalized = maxValue > 0 ? (value / maxValue) * 100 : 0
  if (normalized <= 30) return "bg-cyan-950"
  if (normalized <= 60) return "bg-cyan-700"
  if (normalized <= 90) return "bg-cyan-500"
  return "bg-cyan-400"
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

export function HeatmapCalendar({ monthKey, dayTotals }: HeatmapCalendarProps) {
  const { year, month, monthName, daysInMonth, firstDayOfWeek, maxValue, days } = useMemo(() => {
    const [yearStr, monthStr] = monthKey.split("-")
    const y = parseInt(yearStr, 10)
    const m = parseInt(monthStr, 10) - 1 // 0-indexed month
    const daysCount = getDaysInMonth(y, m)
    const firstDay = getFirstDayOfWeek(y, m)

    // Find max value for normalization
    let max = 0
    const dayData: { day: number; value: number }[] = []
    
    for (let d = 1; d <= daysCount; d++) {
      const dateKey = `${monthKey}-${String(d).padStart(2, "0")}`
      const value = dayTotals[dateKey] || 0
      dayData.push({ day: d, value })
      if (value > max) max = value
    }

    return {
      year: y,
      month: m,
      monthName: MONTH_NAMES[m],
      daysInMonth: daysCount,
      firstDayOfWeek: firstDay,
      maxValue: max,
      days: dayData,
    }
  }, [monthKey, dayTotals])

  const weekDays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]

  return (
    <div className="w-full max-w-md mx-auto p-6 bg-slate-900 rounded-xl">
      <h2 className="text-xl font-semibold text-cyan-50 mb-4 text-center">
        {monthName} {year}
      </h2>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-2 mb-2">
        {weekDays.map((day) => (
          <div
            key={day}
            className="aspect-square flex items-center justify-center text-xs font-medium text-slate-500"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-2">
        {/* Empty cells for days before the first of the month */}
        {Array.from({ length: firstDayOfWeek }).map((_, i) => (
          <div key={`empty-${i}`} className="aspect-square" />
        ))}

        {/* Actual days */}
        {days.map((item) => {
          const isBestDay = maxValue > 0 && item.value / maxValue > 0.9
          const colorClass = getHeatmapColor(item.value, maxValue)

          return (
            <div
              key={item.day}
              className={`
                aspect-square
                rounded-md
                flex
                items-center
                justify-center
                text-sm
                font-medium
                text-cyan-50
                transition-all
                ${colorClass}
                ${isBestDay ? "animate-pulse shadow-[0_0_15px_#00ffff]" : ""}
              `}
              title={`${monthName} ${item.day}: $${item.value.toFixed(2)}`}
            >
              {item.day}
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-cyan-100">
        <span>Less</span>
        <div className="flex gap-1">
          <div className="w-4 h-4 rounded-sm bg-slate-800" />
          <div className="w-4 h-4 rounded-sm bg-cyan-950" />
          <div className="w-4 h-4 rounded-sm bg-cyan-700" />
          <div className="w-4 h-4 rounded-sm bg-cyan-500" />
          <div className="w-4 h-4 rounded-sm bg-cyan-400 animate-pulse shadow-[0_0_15px_#00ffff]" />
        </div>
        <span>More</span>
      </div>
    </div>
  )
}

export default HeatmapCalendar
