"use client"

import { useMemo } from "react"

interface DayData {
  day: number
  value: number
}

function generateMockData(): DayData[] {
  return Array.from({ length: 30 }, (_, i) => ({
    day: i + 1,
    value: Math.floor(Math.random() * 101),
  }))
}

function getHeatmapColor(value: number): string {
  if (value === 0) return "bg-slate-800"
  if (value <= 30) return "bg-cyan-950"
  if (value <= 60) return "bg-cyan-700"
  if (value <= 90) return "bg-cyan-500"
  return "bg-cyan-400"
}

export function HeatmapCalendar() {
  const data = useMemo(() => generateMockData(), [])

  return (
    <div className="w-full max-w-md mx-auto p-6 bg-slate-900 rounded-xl">
      <h2 className="text-xl font-semibold text-cyan-50 mb-4 text-center">
        Activity Heatmap
      </h2>
      
      <div className="grid grid-cols-7 gap-2">
        {data.map((item) => {
          const isBestDay = item.value > 90
          const colorClass = getHeatmapColor(item.value)
          
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
              title={`Day ${item.day}: ${item.value}%`}
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
