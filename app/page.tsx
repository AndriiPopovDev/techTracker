import TechExpertTracker from "@/components/tech-expert-tracker"
import { HeatmapCalendar } from "@/components/heatmap-calendar"

export default function Page() {
  return (
    <div className="min-h-screen bg-slate-950 py-8">
      <HeatmapCalendar />
      <div className="mt-8">
        <TechExpertTracker />
      </div>
    </div>
  )
}
