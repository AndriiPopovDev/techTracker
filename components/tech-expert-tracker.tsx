"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { flushSync } from "react-dom"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis } from "recharts"
import { Calendar, Wallet, Briefcase, Percent, TrendingUp, TrendingDown, Coins, Coffee, CircleCheck as CheckCircle2, History as HistoryIcon, Sparkles, X, ChevronLeft, ChevronRight, ChevronDown, Pencil, Trash2, Download, Upload, Target, Settings as SettingsIcon, Lock, Minus, LayoutGrid, Rows3 } from "lucide-react"
import { toast } from "sonner"
import { DayPicker } from "react-day-picker"
import { HeatmapCalendar } from "@/components/heatmap-calendar"

const SERVICES_COLOR = "#3b82f6" // blue
const BASE_COLOR = "#22c55e" // green
const TRADING_COLOR = "#f59e0b" // amber
const TEA_COLOR = "#ec4899" // pink

const MULTIPLIERS = [-0.2, -0.1, 0, 0.1, 0.2]
const TARGET_SHIFTS_PER_MONTH = 22
const ELECTRIC_CYAN = "#00f2ff"

type DraftRecord = {
  servicesRaw: number | string
  hasBaseRate: boolean
  tradeEarnings: number | string
  teaEarnings: number | string
}

type HistoryEntry = {
  id: string
  date: string
  savedAt: number
  // Raw per-shift values (multiplier is global, not stored per shift)
  servicesRaw: number
  hasBaseRate: boolean
  baseRateRaw: number // 400 if hasBaseRate else 0
  tradeEarnings: number
  teaEarnings: number
  // Legacy fields kept for backwards-compat with previously saved entries
  multiplier?: number
  finalServices?: number
  baseRate?: number
  trading?: number
  total?: number
}

const DEFAULT_DRAFT: DraftRecord = {
  servicesRaw: "",
  hasBaseRate: false,
  tradeEarnings: "",
  teaEarnings: "",
}

const DRAFT_KEY = "techExpertEarnings"
const HISTORY_KEY = "techExpertHistory"
const MULTIPLIER_KEY = "techExpertMultiplier"
const GOALS_KEY = "techExpertGoals" // monthly RAW services goal (per month key)
const AUTO_MULT_KEY = "techExpertAutoMultiplier"
const LAYOUT_MODE_KEY = "techExpertLayoutMode" // "compact" (legend visible, cards hidden) | "detailed" (legend hidden, cards visible)
const AFTER_SAVE_KEY = "techExpertAfterSaveBehavior" // "close" | "staySameDayClear" | "stayNextDay"
const PRESETS_KEY = "techExpertPresets"
const BACKUPS_KEY = "techExpertBackups"
const LAST_BACKUP_DAY_KEY = "techExpertLastBackupDay"
type LayoutMode = "compact" | "detailed"
type AfterSaveBehavior = "close" | "staySameDayClear" | "stayNextDay"

type PresetTarget = "servicesRaw" | "tradeEarnings" | "teaEarnings"
type PresetMode = "replace" | "append"
type Preset = {
  id: string
  name: string
  target: PresetTarget
  mode: PresetMode
  value: string
}

type BackupSnapshot = {
  id: string
  createdAt: number
  data: {
    version: 1
    multiplier: number
    autoMultiplier: boolean
    goals: Record<string, number>
    drafts: Record<string, DraftRecord>
    history: HistoryEntry[]
    layoutMode: LayoutMode
    afterSaveBehavior: AfterSaveBehavior
    presets: Preset[]
  }
}

const DEFAULT_PRESETS: Preset[] = [
  { id: "base-day", name: "Base day", target: "servicesRaw", mode: "replace", value: "15000" },
  { id: "busy-day", name: "Busy day", target: "servicesRaw", mode: "replace", value: "25000" },
  { id: "typical-tips", name: "Typical tips", target: "teaEarnings", mode: "replace", value: "200" },
]

const DEFAULT_GOAL = 50000

// Map a forecast % (0..∞) to the auto-calculated multiplier per spec
const autoMultiplierFor = (forecastPct: number): number => {
  if (forecastPct < 81) return -0.2
  if (forecastPct < 91) return -0.1
  if (forecastPct < 110) return 0
  if (forecastPct < 120) return 0.1
  return 0.2
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const monthKeyOf = (dateStr: string) => dateStr.slice(0, 7) // "YYYY-MM"

// Cyan accent reserved for the positive-multiplier "bonus" tail.
// Distinct from the standard "Base Rate" green so the two are never confused.
const BONUS_COLOR = "#06b6d4" // cyan-500 / biryuza
const BONUS_GLOW = "#67e8f9" // cyan-300 — used for halo accents

// Format an integer UAH amount with a thin space as the thousands separator,
// matching the visual style requested in the spec ("12 000 UAH (+2 000)").
const fmtUah = (n: number) => Math.round(n).toLocaleString("en-US").replace(/,/g, "\u202f")

// Helpers to read legacy entries safely
const entryRawServices = (e: HistoryEntry) => Number(e.servicesRaw) || 0
const entryRawBase = (e: HistoryEntry) =>
  typeof e.baseRateRaw === "number" ? e.baseRateRaw : e.hasBaseRate ? 400 : 0
const entryTrading = (e: HistoryEntry) =>
  typeof e.tradeEarnings === "number" ? e.tradeEarnings : Number(e.trading) || 0
const entryTea = (e: HistoryEntry) => Number(e.teaEarnings) || 0

const entryTotalWithMultiplier = (e: HistoryEntry, globalMultiplier: number) => {
  const s = entryRawServices(e) * 0.035 * (1 + globalMultiplier)
  const b = entryRawBase(e) * (1 + globalMultiplier)
  const t = entryTrading(e)
  const tea = entryTea(e)
  return s + b + t + tea
}

function evalMiniExpr(expr: string): { ok: true; value: number } | { ok: false; error: string } {
  // Safe mini evaluator for + - * / and parentheses (no eval()).
  const cleaned = expr.replace(/\s+/g, "")
  if (!cleaned) return { ok: false, error: "Empty" }
  if (cleaned.length > 64) return { ok: false, error: "Too long" }
  if (/[^0-9+\-*/().]/.test(cleaned)) return { ok: false, error: "Invalid chars" }

  type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" }
  const tokens: Tok[] = []

  let i = 0
  while (i < cleaned.length) {
    const ch = cleaned[i]
    if (ch === "(") {
      tokens.push({ t: "lp" })
      i++
      continue
    }
    if (ch === ")") {
      tokens.push({ t: "rp" })
      i++
      continue
    }
    if ("+-*/".includes(ch)) {
      const prev = tokens[tokens.length - 1]
      const isUnary = ch === "-" && (!prev || prev.t === "op" || prev.t === "lp")
      if (isUnary) tokens.push({ t: "num", v: 0 })
      tokens.push({ t: "op", v: ch })
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < cleaned.length && /[0-9.]/.test(cleaned[j])) j++
      const raw = cleaned.slice(i, j)
      if ((raw.match(/\./g) || []).length > 1) return { ok: false, error: "Bad number" }
      const n = Number(raw)
      if (!Number.isFinite(n)) return { ok: false, error: "Bad number" }
      tokens.push({ t: "num", v: n })
      i = j
      continue
    }
    return { ok: false, error: "Parse error" }
  }

  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 }
  const output: Tok[] = []
  const ops: Tok[] = []

  for (const tok of tokens) {
    if (tok.t === "num") output.push(tok)
    else if (tok.t === "op") {
      while (ops.length) {
        const top = ops[ops.length - 1]
        if (top.t === "op" && prec[top.v] >= prec[tok.v]) output.push(ops.pop()!)
        else break
      }
      ops.push(tok)
    } else if (tok.t === "lp") ops.push(tok)
    else if (tok.t === "rp") {
      while (ops.length && ops[ops.length - 1].t !== "lp") output.push(ops.pop()!)
      if (!ops.length) return { ok: false, error: "Mismatched ()" }
      ops.pop()
    }
  }
  while (ops.length) {
    const top = ops.pop()!
    if (top.t === "lp") return { ok: false, error: "Mismatched ()" }
    output.push(top)
  }

  const stack: number[] = []
  for (const tok of output) {
    if (tok.t === "num") stack.push(tok.v)
    else if (tok.t === "op") {
      const b = stack.pop()
      const a = stack.pop()
      if (a === undefined || b === undefined) return { ok: false, error: "Bad expr" }
      let r = 0
      if (tok.v === "+") r = a + b
      if (tok.v === "-") r = a - b
      if (tok.v === "*") r = a * b
      if (tok.v === "/") {
        if (b === 0) return { ok: false, error: "Divide by 0" }
        r = a / b
      }
      if (!Number.isFinite(r)) return { ok: false, error: "Bad result" }
      stack.push(r)
    }
  }
  if (stack.length !== 1) return { ok: false, error: "Bad expr" }
  return { ok: true, value: Number(stack[0].toFixed(6)) }
}

export default function TechExpertTracker() {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split("T")[0])
  const [drafts, setDrafts] = useState<Record<string, DraftRecord>>({})
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [globalMultiplier, setGlobalMultiplier] = useState(0)
  const [goals, setGoals] = useState<Record<string, number>>({})
  const [isLoaded, setIsLoaded] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyMonth, setHistoryMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [autoMultiplier, setAutoMultiplier] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shiftModalOpen, setShiftModalOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [heatmapOpen, setHeatmapOpen] = useState(false)
  const heatmapRef = useRef<HTMLDivElement>(null)
  const [afterSaveBehavior, setAfterSaveBehavior] = useState<AfterSaveBehavior>("staySameDayClear")
  const [presets, setPresets] = useState<Preset[]>(DEFAULT_PRESETS)
  const [backups, setBackups] = useState<BackupSnapshot[]>([])
  // Compact: legend next to chart, summary cards hidden. Detailed: cards visible, legend hidden.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("compact")
  const [thisMonthVisibleCount, setThisMonthVisibleCount] = useState(4)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const shiftModalServicesInputRef = useRef<HTMLInputElement>(null)

  // Hydrate from localStorage
  useEffect(() => {
    try {
      const savedDrafts = localStorage.getItem(DRAFT_KEY)
      if (savedDrafts) setDrafts(JSON.parse(savedDrafts))
      const savedHistory = localStorage.getItem(HISTORY_KEY)
      if (savedHistory) setHistory(JSON.parse(savedHistory))
      const savedMult = localStorage.getItem(MULTIPLIER_KEY)
      if (savedMult !== null) {
        const parsed = Number(savedMult)
        if (!Number.isNaN(parsed)) setGlobalMultiplier(parsed)
      }
      const savedGoals = localStorage.getItem(GOALS_KEY)
      if (savedGoals) setGoals(JSON.parse(savedGoals))
      const savedAuto = localStorage.getItem(AUTO_MULT_KEY)
      if (savedAuto !== null) setAutoMultiplier(savedAuto === "true")
      const savedLayout = localStorage.getItem(LAYOUT_MODE_KEY)
      if (savedLayout === "compact" || savedLayout === "detailed") setLayoutMode(savedLayout)
      const savedAfterSave = localStorage.getItem(AFTER_SAVE_KEY)
      if (savedAfterSave === "close" || savedAfterSave === "staySameDayClear" || savedAfterSave === "stayNextDay") {
        setAfterSaveBehavior(savedAfterSave)
      }
      const savedPresets = localStorage.getItem(PRESETS_KEY)
      if (savedPresets) {
        const parsed = JSON.parse(savedPresets)
        if (Array.isArray(parsed) && parsed.length > 0) setPresets(parsed)
      } else {
        localStorage.setItem(PRESETS_KEY, JSON.stringify(DEFAULT_PRESETS))
      }
      const savedBackups = localStorage.getItem(BACKUPS_KEY)
      if (savedBackups) {
        const parsed = JSON.parse(savedBackups)
        if (Array.isArray(parsed)) setBackups(parsed)
      }
    } catch {
      /* noop */
    }
    setIsLoaded(true)
  }, [])

  const updateAfterSaveBehavior = (next: AfterSaveBehavior) => {
    setAfterSaveBehavior(next)
    localStorage.setItem(AFTER_SAVE_KEY, next)
  }

  const updatePresets = (next: Preset[]) => {
    setPresets(next)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next))
  }

  const applySnapshot = (snap: BackupSnapshot["data"]) => {
    setHistory(snap.history)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(snap.history))
    setDrafts(snap.drafts)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(snap.drafts))
    setGoals(snap.goals)
    localStorage.setItem(GOALS_KEY, JSON.stringify(snap.goals))
    setGlobalMultiplier(snap.multiplier)
    localStorage.setItem(MULTIPLIER_KEY, String(snap.multiplier))
    setAutoMultiplier(!!snap.autoMultiplier)
    localStorage.setItem(AUTO_MULT_KEY, String(!!snap.autoMultiplier))
    setLayoutMode(snap.layoutMode)
    localStorage.setItem(LAYOUT_MODE_KEY, snap.layoutMode)
    setAfterSaveBehavior(snap.afterSaveBehavior)
    localStorage.setItem(AFTER_SAVE_KEY, snap.afterSaveBehavior)
    setPresets(snap.presets)
    localStorage.setItem(PRESETS_KEY, JSON.stringify(snap.presets))
  }

  const pushBackup = (reason: "confirmShift" | "daily") => {
    const todayKey = new Date().toISOString().slice(0, 10)
    if (reason === "daily") {
      const last = localStorage.getItem(LAST_BACKUP_DAY_KEY)
      if (last === todayKey) return
      localStorage.setItem(LAST_BACKUP_DAY_KEY, todayKey)
    }

    const snap: BackupSnapshot = {
      id: `b-${Date.now()}`,
      createdAt: Date.now(),
      data: {
        version: 1,
        multiplier: globalMultiplier,
        autoMultiplier,
        goals,
        drafts,
        history,
        layoutMode,
        afterSaveBehavior,
        presets,
      },
    }
    const next = [snap, ...backups].slice(0, 10)
    setBackups(next)
    localStorage.setItem(BACKUPS_KEY, JSON.stringify(next))
  }

  const currentRecord: DraftRecord = drafts[selectedDate] || DEFAULT_DRAFT

  // Draft preview (today's pending shift) — also affected by global multiplier
  const draftServicesEval = evalMiniExpr(String(currentRecord.servicesRaw ?? ""))
  const draftServicesRaw = draftServicesEval.ok ? draftServicesEval.value : 0
  const draftBaseRaw = currentRecord.hasBaseRate ? 400 : 0
  const draftTradingEval = evalMiniExpr(String(currentRecord.tradeEarnings ?? ""))
  const draftTrading = draftTradingEval.ok ? draftTradingEval.value : 0
  const draftTeaEval = evalMiniExpr(String(currentRecord.teaEarnings ?? ""))
  const draftTea = draftTeaEval.ok ? draftTeaEval.value : 0
  const draftFinalServices = draftServicesRaw * 0.035 * (1 + globalMultiplier)
  const draftFinalBase = draftBaseRaw * (1 + globalMultiplier)
  const draftTotal = draftFinalServices + draftFinalBase + draftTrading + draftTea

  // Selected month + cumulative totals from confirmed history
  const selectedMonthKey = monthKeyOf(selectedDate)
  const monthEntries = useMemo(
    () => history.filter((e) => monthKeyOf(e.date) === selectedMonthKey),
    [history, selectedMonthKey],
  )

  useEffect(() => {
    setThisMonthVisibleCount(4)
  }, [selectedMonthKey])

  // Close heatmap popover when clicking outside
  useEffect(() => {
    if (!heatmapOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (heatmapRef.current && !heatmapRef.current.contains(e.target as Node)) {
        setHeatmapOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [heatmapOpen])

  const dayTotals = useMemo(() => {
    const map: Record<string, number> = {}
    for (const e of history) {
      const s = entryRawServices(e) * 0.035 * (1 + globalMultiplier)
      const b = entryRawBase(e) * (1 + globalMultiplier)
      const t = entryTrading(e)
      const tea = entryTea(e)
      const total = s + b + t + tea
      map[e.date] = (map[e.date] || 0) + total
    }
    return map
  }, [history, globalMultiplier])

  // Sum raw values from history; multiplier is applied dynamically here.
  const monthRaw = useMemo(() => {
    return monthEntries.reduce(
      (acc, e) => {
        acc.servicesRaw += entryRawServices(e)
        acc.baseRaw += entryRawBase(e)
        acc.trading += entryTrading(e)
        acc.tea += entryTea(e)
        return acc
      },
      { servicesRaw: 0, baseRaw: 0, trading: 0, tea: 0 },
    )
  }, [monthEntries])

  const monthTotals = useMemo(() => {
    const services = monthRaw.servicesRaw * 0.035 * (1 + globalMultiplier)
    const base = monthRaw.baseRaw * (1 + globalMultiplier)
    const trading = monthRaw.trading
    const tea = monthRaw.tea
    return { services, base, trading, tea, total: services + base + trading + tea }
  }, [monthRaw, globalMultiplier])

  // Previous month total (for trend indicator)
  const prevMonthKey = useMemo(() => {
    const [y, m] = selectedMonthKey.split("-").map(Number)
    const d = new Date(y, m - 2, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  }, [selectedMonthKey])

  const prevMonthTotal = useMemo(() => {
    const raw = history
      .filter((e) => monthKeyOf(e.date) === prevMonthKey)
      .reduce(
        (acc, e) => {
          acc.servicesRaw += entryRawServices(e)
          acc.baseRaw += entryRawBase(e)
          acc.trading += entryTrading(e)
          acc.tea += entryTea(e)
          return acc
        },
        { servicesRaw: 0, baseRaw: 0, trading: 0, tea: 0 },
      )
    // Use the same global multiplier so the comparison is apples-to-apples on rates
    return raw.servicesRaw * 0.035 * (1 + globalMultiplier) + raw.baseRaw * (1 + globalMultiplier) + raw.trading + raw.tea
  }, [history, prevMonthKey, globalMultiplier])

  const trendDeltaPct = prevMonthTotal > 0 ? ((monthTotals.total - prevMonthTotal) / prevMonthTotal) * 100 : null

  // Monthly Services Goal (RAW services target)
  const currentGoal = goals[selectedMonthKey] ?? DEFAULT_GOAL

  // Progress = % of services goal reached so far (raw services accumulated this month)
  const goalProgress = currentGoal > 0 ? Math.min(monthRaw.servicesRaw / currentGoal, 1) : 0
  const goalPct = currentGoal > 0 ? Math.round((monthRaw.servicesRaw / currentGoal) * 100) : 0

  // End-of-month forecast = (cumulative raw services / day-of-month) * days-in-month
  // Also compute required per-day raw services to reach 102% of the goal by month end.
  const { forecastRawServices, forecastPct, needPerDayRaw102 } = useMemo(() => {
    const today = new Date()
    const [y, m] = selectedMonthKey.split("-").map(Number)
    const isCurrent = today.getFullYear() === y && today.getMonth() === m - 1
    const isPast = new Date(y, m - 1, 1).getTime() < new Date(today.getFullYear(), today.getMonth(), 1).getTime()
    const daysInMonth = new Date(y, m, 0).getDate()
    // For past months, forecast == actual. For future months, no forecast.
    const dayOfMonth = isCurrent ? today.getDate() : isPast ? daysInMonth : 1
    const projected = isCurrent
      ? (monthRaw.servicesRaw / Math.max(dayOfMonth, 1)) * daysInMonth
      : isPast
        ? monthRaw.servicesRaw
        : 0

    // Needed/day to close at 102% (only meaningful for current month)
    const needPerDayRaw102 = (() => {
      if (!isCurrent) return null
      if (currentGoal <= 0) return null
      const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1) // include today
      const target = currentGoal * 1.02
      const remaining = Math.max(0, target - monthRaw.servicesRaw)
      return remaining / remainingDays
    })()

    return {
      forecastRawServices: projected,
      forecastPct: currentGoal > 0 ? (projected / currentGoal) * 100 : 0,
      needPerDayRaw102,
    }
  }, [monthRaw.servicesRaw, currentGoal, selectedMonthKey])

  const avgPerShift = monthEntries.length > 0 ? monthTotals.total / monthEntries.length : 0
  const avgForecastTotal = avgPerShift * TARGET_SHIFTS_PER_MONTH

  const last6Months = useMemo(() => {
    // Build a per-month total map for all history entries.
    const byMonth: Record<string, number> = {}
    for (const e of history) {
      const k = monthKeyOf(e.date)
      byMonth[k] = (byMonth[k] ?? 0) + entryTotalWithMultiplier(e, globalMultiplier)
    }

    const [y, m] = selectedMonthKey.split("-").map(Number)
    const keys: string[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(y, m - 1 - i, 1)
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`)
    }

    return keys.map((k) => {
      const [yy, mm] = k.split("-").map(Number)
      return {
        key: k,
        month: MONTH_NAMES[mm - 1].slice(0, 3),
        year: yy,
        value: Number(((byMonth[k] ?? 0) || 0).toFixed(2)),
      }
    })
  }, [history, globalMultiplier, selectedMonthKey])

  const updateRecord = (field: keyof DraftRecord, value: any) => {
    const next = {
      ...drafts,
      [selectedDate]: {
        ...currentRecord,
        [field]: value,
      },
    }
    setDrafts(next)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(next))
  }

  const updateGlobalMultiplier = (m: number) => {
    if (autoMultiplier) return // locked when auto mode is on
    setGlobalMultiplier(m)
    localStorage.setItem(MULTIPLIER_KEY, String(m))
  }

  const updateServicesGoal = (next: number) => {
    const safe = Math.max(0, Math.floor(next) || 0)
    const nextGoals = { ...goals, [selectedMonthKey]: safe }
    setGoals(nextGoals)
    localStorage.setItem(GOALS_KEY, JSON.stringify(nextGoals))
  }

  const updateAutoMultiplier = (next: boolean) => {
    setAutoMultiplier(next)
    localStorage.setItem(AUTO_MULT_KEY, String(next))
  }

  const updateLayoutMode = (next: LayoutMode) => {
    setLayoutMode(next)
    localStorage.setItem(LAYOUT_MODE_KEY, next)
  }

  // Auto-derive the global multiplier from the forecast when auto mode is ON
  useEffect(() => {
    if (!autoMultiplier) return
    const target = autoMultiplierFor(forecastPct)
    if (target !== globalMultiplier) {
      setGlobalMultiplier(target)
      localStorage.setItem(MULTIPLIER_KEY, String(target))
    }
  }, [autoMultiplier, forecastPct, globalMultiplier])

  const confirmShift = () => {
    if (draftTotal <= 0) return
    pushBackup("daily")
    const prevHistory = history
    const prevDrafts = drafts
    const existing = history.find((e) => e.date === selectedDate)
    const mergedServicesRaw = existing ? entryRawServices(existing) + draftServicesRaw : draftServicesRaw
    const mergedTrading = existing ? entryTrading(existing) + draftTrading : draftTrading
    const mergedTea = existing ? entryTea(existing) + draftTea : draftTea
    const mergedHasBase = existing ? entryRawBase(existing) > 0 || currentRecord.hasBaseRate : currentRecord.hasBaseRate

    const entry: HistoryEntry = {
      id: existing?.id ?? `${selectedDate}-${Date.now()}`,
      date: selectedDate,
      savedAt: Date.now(),
      servicesRaw: mergedServicesRaw,
      hasBaseRate: mergedHasBase,
      baseRateRaw: mergedHasBase ? 400 : 0,
      tradeEarnings: Number(mergedTrading.toFixed(2)),
      teaEarnings: Number(mergedTea.toFixed(2)),
    }

    // One shift per day: if an entry for this date exists, merge-add the new draft values into it.
    const nextHistory = existing ? [entry, ...history.filter((e) => e.date !== selectedDate)] : [entry, ...history]
    setHistory(nextHistory)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))

    // Clear the current day's draft inputs (Services, Base Rate, Trading, Tea)
    const nextDrafts = { ...drafts, [selectedDate]: { ...DEFAULT_DRAFT } }
    setDrafts(nextDrafts)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(nextDrafts))

    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1800)

    pushBackup("confirmShift")

    toast("Shift saved", {
      description: "Tap Undo to restore the previous state.",
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          setHistory(prevHistory)
          localStorage.setItem(HISTORY_KEY, JSON.stringify(prevHistory))
          setDrafts(prevDrafts)
          localStorage.setItem(DRAFT_KEY, JSON.stringify(prevDrafts))
          setJustSaved(false)
        },
      },
    })
  }

  const openShiftModal = () => {
    // Always default to today when starting a new shift entry from the FAB.
    const today = new Date().toISOString().split("T")[0]
    // iOS Safari often blocks programmatic keyboard unless focus happens
    // synchronously within the user gesture. Flush render, then focus.
    flushSync(() => {
      setSelectedDate(today)
      setShiftModalOpen(true)
    })
    shiftModalServicesInputRef.current?.focus()
  }

  // When the modal opens, focus the first input so iOS shows the keyboard.
  useEffect(() => {
    if (!shiftModalOpen) return
    const id = globalThis.setTimeout(() => {
      shiftModalServicesInputRef.current?.focus()
    }, 50)
    return () => globalThis.clearTimeout(id)
  }, [shiftModalOpen])

  // Prevent background (body) scroll while modal is open (especially iOS).
  useEffect(() => {
    if (!shiftModalOpen) return
    const body = document.body
    const prevOverflow = body.style.overflow
    body.style.overflow = "hidden"
    return () => {
      body.style.overflow = prevOverflow
    }
  }, [shiftModalOpen])

  const deleteEntry = (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Delete this shift? This cannot be undone.")) return
    const nextHistory = history.filter((e) => e.id !== id)
    setHistory(nextHistory)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))
  }

  const editEntry = (entry: HistoryEntry) => {
    // Remove from history, populate the form for that date, switch selected date and close modal
    const nextHistory = history.filter((e) => e.id !== entry.id)
    setHistory(nextHistory)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))

    const nextDrafts: Record<string, DraftRecord> = {
      ...drafts,
      [entry.date]: {
        servicesRaw: entryRawServices(entry) || "",
        hasBaseRate: !!entry.hasBaseRate || entryRawBase(entry) > 0,
        tradeEarnings: entryTrading(entry) || "",
        teaEarnings: entryTea(entry) || "",
      },
    }
    setDrafts(nextDrafts)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(nextDrafts))
    setSelectedDate(entry.date)
    setHistoryOpen(false)
  }

  const exportData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "tech-expert-tracker",
      version: 2,
      multiplier: globalMultiplier,
      autoMultiplier,
      goals,
      drafts,
      history,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `earnings-tracker-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const triggerImport = () => fileInputRef.current?.click()

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (!data || typeof data !== "object") throw new Error("Not a valid JSON object")
      if (!Array.isArray(data.history)) throw new Error("Missing 'history' array")
      if (data.drafts && typeof data.drafts !== "object") throw new Error("Invalid 'drafts'")
      if (data.goals && typeof data.goals !== "object") throw new Error("Invalid 'goals'")
      // Light per-entry sanity check
      for (const e of data.history) {
        if (typeof e?.date !== "string" || typeof e?.id !== "string") {
          throw new Error("History entries are malformed")
        }
      }

      // Overwrite — both state (instant UI refresh) and localStorage
      setHistory(data.history)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(data.history))

      const nextDrafts = data.drafts ?? {}
      setDrafts(nextDrafts)
      localStorage.setItem(DRAFT_KEY, JSON.stringify(nextDrafts))

      const nextGoals = data.goals ?? {}
      setGoals(nextGoals)
      localStorage.setItem(GOALS_KEY, JSON.stringify(nextGoals))

      if (typeof data.multiplier === "number") {
        setGlobalMultiplier(data.multiplier)
        localStorage.setItem(MULTIPLIER_KEY, String(data.multiplier))
      }
      if (typeof data.autoMultiplier === "boolean") {
        setAutoMultiplier(data.autoMultiplier)
        localStorage.setItem(AUTO_MULT_KEY, String(data.autoMultiplier))
      }

      if (typeof window !== "undefined") {
        window.alert("Data imported successfully.")
      }
    } catch (err) {
      if (typeof window !== "undefined") {
        window.alert(`Import failed: ${(err as Error).message}`)
      }
    }
  }

  // Pie chart data — monthly cumulative distribution. Services AND Base Rate
  // are both affected by the global multiplier, so each is decomposed to make
  // the multiplier impact visible:
  //   - Positive m: parent slice = "kept" base + glowing CYAN "bonus" tail
  //   - Negative m: parent slice = full final amount + red striped "loss" tail
  // monthTotals.services / monthTotals.base already have the multiplier baked
  // in (raw * (1 + m)). The label shows the final UAH amount and a signed
  // delta in cyan (+) or red (-) right next to it.
  const chartData = useMemo(() => {
    const m = globalMultiplier

    type Slice = {
      name: string
      value: number
      color: string
      hideLabel?: boolean
      displayValue?: number
      delta?: number
      fillOverride?: string
      filterOverride?: string
    }

    const data: Slice[] = []

    const pushMultipliedSegment = (name: string, finalAmount: number, color: string) => {
      if (finalAmount <= 0) return
      if (m > 0) {
        const base0 = finalAmount / (1 + m)
        const bonus = finalAmount - base0
        data.push({
          name,
          value: Number(base0.toFixed(2)),
          color,
          // Show the FINAL value as the headline number, with the bonus as suffix
          displayValue: finalAmount,
          delta: bonus,
        })
        if (bonus > 0) {
          data.push({
            name: `${name} Bonus`,
            value: Number(bonus.toFixed(2)),
            // Bright pale-cyan core (#a5f3fc) instead of the deeper cyan-500 — looks like
            // a glowing neon tube once the bonusGlow halo filter is applied on top.
            color: "#a5f3fc",
            hideLabel: true,
            filterOverride: "url(#bonusGlow)",
          })
        }
      } else if (m < 0) {
        // Final amount is the kept value; draw a "phantom" striped tail equal
        // to the would-have-been earnings that were sacrificed by the negative
        // multiplier. The tail is purely visual — it doesn't change the total.
        const lost = (finalAmount * -m) / (1 + m)
        data.push({
          name,
          value: Number(finalAmount.toFixed(2)),
          color,
          displayValue: finalAmount,
          delta: -lost,
        })
        if (lost > 0) {
          data.push({
            name: `${name} Loss`,
            value: Number(lost.toFixed(2)),
            color: "#ef4444",
            hideLabel: true,
            fillOverride: "url(#lossStripes)",
          })
        }
      } else {
        data.push({
          name,
          value: Number(finalAmount.toFixed(2)),
          color,
          displayValue: finalAmount,
        })
      }
    }

    pushMultipliedSegment("Services", monthTotals.services, SERVICES_COLOR)
    pushMultipliedSegment("Base Rate", monthTotals.base, BASE_COLOR)

    if (monthTotals.trading > 0) {
      data.push({
        name: "Trading",
        value: Number(monthTotals.trading.toFixed(2)),
        color: TRADING_COLOR,
        displayValue: monthTotals.trading,
      })
    }
    if (monthTotals.tea > 0) {
      data.push({
        name: "Tea",
        value: Number(monthTotals.tea.toFixed(2)),
        color: TEA_COLOR,
        displayValue: monthTotals.tea,
      })
    }

    return data
  }, [monthTotals, globalMultiplier])

  // Compact legend data — replaces the donut's external leader-line labels.
  // Shows: color dot + icon + name + final UAH; with a smaller, subtle delta
  // suffix when the global multiplier is non-zero (cyan for +, red for -).
  const legendItems = useMemo(() => {
    const m = globalMultiplier
    type LegendItem = {
      name: string
      color: string
      value: number
      delta?: number
      icon: React.ReactNode
    }
    const items: LegendItem[] = []
    if (monthTotals.services > 0) {
      const base0 = monthTotals.services / (1 + m)
      items.push({
        name: "Services",
        color: SERVICES_COLOR,
        value: monthTotals.services,
        delta: m !== 0 ? monthTotals.services - base0 : undefined,
        icon: <Briefcase className="w-3 h-3" />,
      })
    }
    if (monthTotals.base > 0) {
      const base0 = monthTotals.base / (1 + m)
      items.push({
        name: "Base Rate",
        color: BASE_COLOR,
        value: monthTotals.base,
        delta: m !== 0 ? monthTotals.base - base0 : undefined,
        icon: <CheckCircle2 className="w-3 h-3" />,
      })
    }
    if (monthTotals.trading > 0) {
      items.push({
        name: "Trading",
        color: TRADING_COLOR,
        value: monthTotals.trading,
        icon: <Coins className="w-3 h-3" />,
      })
    }
    if (monthTotals.tea > 0) {
      items.push({
        name: "Tea",
        color: TEA_COLOR,
        value: monthTotals.tea,
        icon: <Coffee className="w-3 h-3" />,
      })
    }
    return items
  }, [monthTotals, globalMultiplier])

  if (!isLoaded) return null

  const multiplierPct = Math.round(globalMultiplier * 100)
  const multiplierTone =
    multiplierPct > 0 ? "text-emerald-400" : multiplierPct < 0 ? "text-red-400" : "text-slate-200"

  // Soft progress fractions for chips
  const cumTotal = monthTotals.total
  const fracServices = cumTotal > 0 ? Math.min(monthTotals.services / cumTotal, 1) : 0
  const fracBase = cumTotal > 0 ? Math.min(monthTotals.base / cumTotal, 1) : 0
  const fracTrade = cumTotal > 0 ? Math.min(monthTotals.trading / cumTotal, 1) : 0
  const fracTea = cumTotal > 0 ? Math.min(monthTotals.tea / cumTotal, 1) : 0

  const [selYear, selMonth] = selectedMonthKey.split("-").map(Number)
  const selectedMonthLabel = `${MONTH_NAMES[selMonth - 1]} ${selYear}`

  return (
    <div className="min-h-screen text-slate-100 font-sans bg-fixed bg-[radial-gradient(ellipse_at_top,_#1e3a8a_0%,_#0b1226_45%,_#05080f_100%)]">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleImportFile(file)
          // Reset so picking the same file twice still triggers onChange
          e.target.value = ""
        }}
      />
      <div className="mx-auto max-w-md px-4 pt-6 pb-24 sm:max-w-lg sm:px-5 sm:pt-8">
        {/* Header */}
        <header className="flex items-center justify-between mb-4 gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shadow-[0_0_20px_-4px_rgba(59,130,246,0.6)] shrink-0">
              <Sparkles className="w-4 h-4 text-blue-300" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-white leading-tight truncate">Earnings Tracker</h1>
              <p className="text-[11px] text-slate-400 leading-tight">Tech expert dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <label className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-white/5 backdrop-blur-md border border-white/10">
              <Calendar className="w-4 h-4 text-blue-300 shrink-0" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent border-none outline-none text-xs font-medium text-slate-100 cursor-pointer w-[100px] [color-scheme:dark]"
              />
            </label>
            <div ref={heatmapRef} className="relative">
              <button
                type="button"
                aria-label="Open heatmap calendar"
                onClick={() => setHeatmapOpen((prev) => !prev)}
                className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 backdrop-blur-md border border-white/10 flex items-center justify-center transition-colors"
              >
                <Calendar className="w-4 h-4 text-blue-300" />
              </button>
              {heatmapOpen && (
                <div className="absolute right-0 top-full mt-2 z-50 rounded-xl bg-slate-900 border border-white/10 shadow-2xl">
                  <HeatmapCalendar />
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="View history"
              onClick={() => {
                setHistoryMonth(selectedMonthKey)
                setHistoryOpen(true)
              }}
              className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 backdrop-blur-md border border-white/10 flex items-center justify-center transition-colors"
            >
              <HistoryIcon className="w-4 h-4 text-blue-300" />
            </button>
          </div>
        </header>

        {/* COMPACT HERO — Balance + Pie + Goal + Multiplier merged into ONE card */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600/20 via-blue-500/5 to-transparent backdrop-blur-xl border border-white/10 p-4 mb-3 shadow-[0_8px_40px_-12px_rgba(59,130,246,0.45)]">
          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-blue-500/30 blur-3xl pointer-events-none" />

          <div className="relative flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-blue-200/80 font-medium">
              <Wallet className="w-3.5 h-3.5" />
              Total Balance
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-200/70 px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-400/20">
                {selectedMonthLabel}
              </span>
              <button
                type="button"
                aria-label="Open settings"
                onClick={() => setSettingsOpen(true)}
                className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
              >
                <SettingsIcon className="w-3.5 h-3.5 text-blue-200" />
              </button>
            </div>
          </div>

          {/* Side-by-side: donut anchor on left, vertical Legend in the middle, Total Balance on the right */}
          <div className="relative flex items-center gap-3 sm:gap-4">
            {/* Donut: visual anchor on the left. No external labels — clean ring with empty center.
                `overflow-visible` on the SVG + small inner margin lets the bonusGlow filter
                bleed past the chart bounds without being clipped at the bottom edge. */}
            <div className="shrink-0 w-[128px] h-[128px] sm:w-[148px] sm:h-[148px] relative [&_svg]:!overflow-visible">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                    <defs>
                      {/* Diagonal striped fill used for the negative-multiplier "loss" tail */}
                      <pattern
                        id="lossStripes"
                        patternUnits="userSpaceOnUse"
                        width={6}
                        height={6}
                        patternTransform="rotate(45)"
                      >
                        <rect width={6} height={6} fill="#ef4444" fillOpacity={0.55} />
                        <line x1={0} y1={0} x2={0} y2={6} stroke="#fecaca" strokeOpacity={0.55} strokeWidth={1} />
                      </pattern>
                      {/* Bright neon-tube cyan: pale-cyan core (almost white) + intense
                          turquoise halo. Renders the bonus arc as a glowing neon segment. */}
                      <radialGradient id="bonusCore" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="#ecfeff" stopOpacity={1} />
                        <stop offset="55%" stopColor="#a5f3fc" stopOpacity={1} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={1} />
                      </radialGradient>
                      <filter id="bonusGlow" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="blurA" />
                        <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blurB" />
                        <feFlood floodColor="#22d3ee" floodOpacity="1" result="haloInner" />
                        <feComposite in="haloInner" in2="blurA" operator="in" result="haloA" />
                        <feFlood floodColor="#06b6d4" floodOpacity="0.85" result="haloOuter" />
                        <feComposite in="haloOuter" in2="blurB" operator="in" result="haloB" />
                        <feMerge>
                          <feMergeNode in="haloB" />
                          <feMergeNode in="haloA" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius="62%"
                      outerRadius="98%"
                      paddingAngle={0}
                      dataKey="value"
                      stroke="none"
                      cornerRadius={3}
                      labelLine={false}
                      label={false}
                      isAnimationActive={false}
                    >
                      {chartData.map((entry) => (
                        <Cell
                          key={entry.name}
                          fill={entry.fillOverride || entry.color}
                          filter={entry.filterOverride}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string) => [`${value.toFixed(2)} UAH`, name]}
                      contentStyle={{
                        borderRadius: "12px",
                        border: "1px solid rgba(255,255,255,0.1)",
                        background: "rgba(15,23,42,0.95)",
                        color: "#f1f5f9",
                        backdropFilter: "blur(8px)",
                        fontSize: 12,
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-[100px] h-[100px] rounded-full border-2 border-dashed border-white/10 flex items-center justify-center text-[10px] text-slate-500 text-center px-2">
                    No shifts yet
                  </div>
                </div>
              )}
            </div>

            {/* Compact vertical Legend — only shown in "compact" layout mode.
                Each row: dot + colored icon + "Name:" + final UAH + subtle delta.
                Name and value sit close together (gap-1) for a tight, readable list. */}
            {layoutMode === "compact" && (
              <ul className="flex-1 min-w-0 self-center space-y-0.5 py-0.5">
                {legendItems.length === 0 ? (
                  <li className="text-[11px] text-slate-500">No data yet</li>
                ) : (
                  legendItems.map((item) => (
                    <li key={item.name} className="flex items-center gap-2 min-w-0 leading-none">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: item.color, boxShadow: `0 0 6px ${item.color}` }}
                      />

                      <span className="inline-flex items-center gap-1 shrink-0">
                        <span className="shrink-0" style={{ color: item.color }}>
                          {item.icon}
                        </span>
                        <span className="text-slate-500 text-[11px] sm:text-xs font-semibold">:</span>
                      </span>

                      <span className="sr-only">{item.name}</span>

                      <span className="text-[11px] sm:text-xs font-semibold text-white tabular-nums">
                        {fmtUah(item.value)}
                      </span>
                      {item.delta !== undefined && Math.abs(item.delta) >= 0.5 && (
                        <span
                          className={`text-[9px] sm:text-[10px] font-medium tabular-nums shrink-0 ${
                            item.delta > 0 ? "text-cyan-300/90" : "text-red-300/90"
                          }`}
                        >
                          {item.delta > 0 ? "+" : "-"}
                          {fmtUah(Math.abs(item.delta))}
                        </span>
                      )}
                    </li>
                  ))
                )}
              </ul>
            )}
            {/* Total Balance — adapts to layout mode:
                · Compact: sits on the right with right-aligned text (legend fills space to its left)
                · Detailed: legend is hidden, so this block grows (`flex-1`) and centers itself
                  next to the donut, producing the balanced 2-column look. */}
            <div
              className={`self-center shrink-0 flex flex-col items-end ${
                layoutMode === "detailed"
                  ? "flex-1 min-w-0 text-center"
                  : "shrink-0"
              }`}
            >
              <div className={`flex items-baseline gap-1.5 ${layoutMode === "detailed" ? "justify-center w-full" : ""}`}>
                <div
                  className={`font-bold text-white tabular-nums tracking-tight leading-none ${
                    layoutMode === "detailed" ? "text-3xl sm:text-4xl" : "text-2xl sm:text-3xl"
                  }`}
                >
                  {fmtUah(monthTotals.total)}
                </div>
                <div className="text-xs sm:text-sm font-semibold text-cyan-300/60">
                  ₴
                </div>
              </div>

              {/* Avg + Forecast cardlet (live projection) */}
              <div
                className={`mt-2 w-full max-w-[180px] rounded-2xl border border-cyan-300/20 bg-cyan-400/5 px-2.5 py-1.5 ${
                  layoutMode === "detailed" ? "mx-auto" : ""
                }`}
                style={{ boxShadow: "0 0 0 1px rgba(0,242,255,0.08) inset, 0 0 18px rgba(0,242,255,0.10)" }}
              >
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Forecast for {selectedMonthLabel}</div>
                <div
                  className="mt-0.5 text-[13px] font-bold tabular-nums text-cyan-200 animate-pulse"
                  style={{ textShadow: "0 0 10px rgba(0,242,255,0.55), 0 0 22px rgba(0,242,255,0.25)" }}
                >
                  {fmtUah(avgForecastTotal)} ₴
                </div>
                <div className="mt-0.5 text-[10px] text-slate-400">
                  Avg per shift: <span className="font-semibold tabular-nums text-slate-200">{fmtUah(avgPerShift)}</span> ₴
                </div>
              </div>
            </div>
          </div>

          {/* Meta row — trend, shifts/avg, multiplier — moved below the chart row for breathing room.
              In detailed mode it centers under the (now-centered) Total Balance value.
              In compact mode it stays left-aligned and tight. */}
          <div
            className={`relative mt-2 flex items-center gap-1.5 flex-wrap text-[11px] ${
              layoutMode === "detailed" ? "justify-center" : "justify-end sm:justify-start"
            }`}
          >
            {trendDeltaPct === null ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-medium text-slate-400">
                <Minus className="w-3 h-3" />
                No prior month
              </span>
            ) : trendDeltaPct >= 0 ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-[10px] font-semibold text-emerald-300">
                <TrendingUp className="w-3 h-3" />
                {`+${trendDeltaPct.toFixed(1)}% vs last month`}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 border border-red-400/30 text-[10px] font-semibold text-red-300">
                <TrendingDown className="w-3 h-3" />
                {`${trendDeltaPct.toFixed(1)}% vs last month`}
              </span>
            )}

            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-300/90">
              <span>
                {monthEntries.length} {monthEntries.length === 1 ? "shift" : "shifts"}
              </span>
              {monthEntries.length > 0 && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">avg</span>
                  <span className="font-semibold text-slate-200 tabular-nums">{avgPerShift.toFixed(0)}</span>
                </>
              )}
            </span>

            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold ${
                multiplierPct > 0
                  ? "bg-cyan-400/10 border border-cyan-300/40 text-cyan-200"
                  : multiplierPct < 0
                    ? "bg-red-500/10 border border-red-400/30 text-red-300"
                    : "bg-white/5 border border-white/10 text-slate-200"
              }`}
              style={
                multiplierPct > 0
                  ? {
                      textShadow: "0 0 6px rgba(34,211,238,0.75), 0 0 14px rgba(6,182,212,0.55)",
                      boxShadow:
                        "0 0 0 1px rgba(34,211,238,0.25), 0 0 12px rgba(34,211,238,0.35), inset 0 0 8px rgba(165,243,252,0.15)",
                    }
                  : undefined
              }
            >
              {multiplierPct > 0 ? "+" : ""}
              {multiplierPct}%
              {autoMultiplier && (
                <span className="ml-1 text-[9px] font-semibold text-blue-300/90 px-1 py-0.5 rounded-md bg-blue-500/15 border border-blue-400/30">
                  AUTO
                </span>
              )}
            </span>
          </div>

          {/* Last 6 months — minimalist neon bar chart */}
          <div className="mt-3 rounded-2xl bg-white/[0.03] border border-white/10 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-slate-300">Last 6 months</div>
              <div className="text-[10px] text-slate-500">hover/tap bar for amount</div>
            </div>
            <div className="h-[96px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={last6Months} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
                  <defs>
                    <linearGradient id="cyanFade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={ELECTRIC_CYAN} stopOpacity={0.95} />
                      <stop offset="55%" stopColor={ELECTRIC_CYAN} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={ELECTRIC_CYAN} stopOpacity={0} />
                    </linearGradient>
                    <filter id="barGlow" x="-100%" y="-100%" width="300%" height="300%">
                      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
                      <feColorMatrix
                        in="blur"
                        type="matrix"
                        values="
                          1 0 0 0 0
                          0 1 0 0 0
                          0 0 1 0 0
                          0 0 0 0.9 0"
                        result="glow"
                      />
                      <feMerge>
                        <feMergeNode in="glow" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  <XAxis
                    dataKey="month"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "rgba(148,163,184,0.8)", fontSize: 10 }}
                  />
                  <YAxis hide />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.03)" }}
                    formatter={(value: number) => [`${value.toFixed(2)} ₴`, "Total"]}
                    labelFormatter={(_, payload) => {
                      const p = payload?.[0]?.payload as any
                      return p ? `${p.month} ${String(p.year).slice(-2)}` : ""
                    }}
                    contentStyle={{
                      borderRadius: "12px",
                      border: "1px solid rgba(255,255,255,0.1)",
                      background: "rgba(15,23,42,0.95)",
                      color: "#f1f5f9",
                      backdropFilter: "blur(8px)",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="value" fill="url(#cyanFade)" radius={[8, 8, 2, 2]} barSize={10} filter="url(#barGlow)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* MONTHLY SERVICES GOAL — thin progress bar with forecast tick */}
          <div className="relative mt-4">
            <div className="flex items-center justify-between mb-1.5 gap-2">
              <div className="flex items-center gap-1.5 text-[11px] text-slate-300/90 min-w-0">
                <Target className="w-3 h-3 text-blue-300 shrink-0" />
                <span className="font-medium">{goalPct}% of services goal</span>
              </div>
              {forecastPct > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-slate-300/90">
                  <span className="text-slate-500">Forecast</span>
                  <span
                    className={`font-bold tabular-nums ${
                      forecastPct >= 110
                        ? "text-emerald-300"
                        : forecastPct >= 91
                          ? "text-blue-200"
                          : forecastPct >= 81
                            ? "text-amber-300"
                            : "text-red-300"
                    }`}
                  >
                    {Math.round(forecastPct)}%
                  </span>

                  {needPerDayRaw102 !== null && (
                    <>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-500">Need/day (102%)</span>
                      <span className="font-bold tabular-nums text-blue-200">{fmtUah(needPerDayRaw102)}</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="relative h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.max(goalProgress * 100, monthRaw.servicesRaw > 0 ? 2 : 0)}%`,
                  background: "linear-gradient(90deg, #3b82f6 0%, #22c55e 100%)",
                  boxShadow: "0 0 12px rgba(59,130,246,0.55)",
                }}
              />
              {forecastPct > 0 && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/80 rounded-full shadow-[0_0_6px_rgba(255,255,255,0.9)] pointer-events-none"
                  style={{ left: `calc(${Math.min(forecastPct, 100)}% - 1px)` }}
                  aria-label={`End-of-month forecast tick at ${Math.round(forecastPct)}%`}
                />
              )}
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500 tabular-nums">
              <span>
                {Math.round(monthRaw.servicesRaw).toLocaleString("en-US")} /{" "}
                {currentGoal.toLocaleString("en-US")} UAH raw
              </span>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="text-blue-300/80 hover:text-blue-200 transition-colors"
              >
                Edit goal
              </button>
            </div>
          </div>

          {/* GLOBAL MULTIPLIER */}
          <div className="relative mt-4 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between mb-1.5 gap-2">
              <label className="text-[11px] font-medium text-slate-300 flex items-center gap-1">
                <Percent className="w-3 h-3" />
                Monthly multiplier
              </label>
              {autoMultiplier ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-300 px-1.5 py-0.5 rounded-md bg-blue-500/15 border border-blue-400/30">
                  <Lock className="w-2.5 h-2.5" />
                  Auto from forecast
                </span>
              ) : (
                <span className="text-[10px] text-slate-500">applies to Services &amp; Base Rate</span>
              )}
            </div>
            {/* Multiplier buttons stay within the hero card's inner width.
                `min-w-0` on the grid prevents long labels from forcing horizontal overflow. */}
            <div className={`grid grid-cols-5 gap-1.5 min-w-0 ${autoMultiplier ? "opacity-70" : ""}`}>
              {MULTIPLIERS.map((m) => {
                const label = m > 0 ? `+${m * 100}%` : m === 0 ? "0%" : `${m * 100}%`
                const isActive = globalMultiplier === m
                // Active styling: positive → electric cyan neon, negative → red neon, zero → blue.
                // Inline style is used for the cyan glow because Tailwind's arbitrary shadow
                // utilities can't compose multiple layered glows as cleanly.
                const isPositiveActive = isActive && m > 0
                const isNegativeActive = isActive && m < 0
                const isZeroActive = isActive && m === 0
                let activeClass = ""
                let activeStyle: React.CSSProperties | undefined
                if (isPositiveActive) {
                  activeClass = "text-slate-900 border border-cyan-200/60"
                  activeStyle = {
                    background:
                      "linear-gradient(180deg, #ecfeff 0%, #a5f3fc 45%, #22d3ee 100%)",
                    boxShadow:
                      "0 0 0 1px rgba(165,243,252,0.7) inset, 0 0 14px rgba(34,211,238,0.85), 0 0 28px rgba(6,182,212,0.55)",
                    textShadow: "0 0 8px rgba(255,255,255,0.6)",
                  }
                } else if (isNegativeActive) {
                  activeClass = "bg-red-500/90 text-white shadow-[0_0_18px_-4px_rgba(239,68,68,0.7)]"
                } else if (isZeroActive) {
                  activeClass = "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                }
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateGlobalMultiplier(m)}
                    disabled={autoMultiplier}
                    aria-disabled={autoMultiplier}
                    className={`py-2 rounded-xl text-xs font-semibold transition-all ${
                      isActive ? activeClass : "bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10"
                    } ${autoMultiplier ? "cursor-not-allowed" : ""}`}
                    style={isActive ? activeStyle : undefined}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        </section>

        {/* Metric chips: 4 categories — only rendered in "detailed" layout mode.
            In compact mode, the legend next to the donut already conveys per-category totals. */}
        {layoutMode === "detailed" && (
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <MetricChip
              label="Services"
              value={monthTotals.services}
              color={SERVICES_COLOR}
              fraction={fracServices}
              icon={<Briefcase className="w-3.5 h-3.5" />}
              multiplier={globalMultiplier}
              showMultiplierDelta
            />
            <MetricChip
              label="Base Rate"
              value={monthTotals.base}
              color={BASE_COLOR}
              fraction={fracBase}
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
              multiplier={globalMultiplier}
              showMultiplierDelta
            />
            <MetricChip
              label="Trading"
              value={monthTotals.trading}
              color={TRADING_COLOR}
              fraction={fracTrade}
              icon={<Coins className="w-3.5 h-3.5" />}
            />
            <MetricChip
              label="Tea"
              value={monthTotals.tea}
              color={TEA_COLOR}
              fraction={fracTea}
              icon={<Coffee className="w-3.5 h-3.5" />}
            />
          </section>
        )}

        {/* Recent History (this month) */}
        <section className="rounded-3xl bg-white/[0.04] backdrop-blur-xl border border-white/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <HistoryIcon className="w-4 h-4 text-blue-300" />
              This Month
            </h2>
            <button
              type="button"
              onClick={() => {
                setHistoryMonth(selectedMonthKey)
                setHistoryOpen(true)
              }}
              className="text-[11px] font-medium text-blue-300 hover:text-blue-200 transition-colors"
            >
              View all
            </button>
          </div>

          {monthEntries.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-sm">
              No confirmed shifts yet. Save your first shift to see it here.
            </div>
          ) : (
            <ul className="space-y-2">
              {monthEntries.slice(0, Math.min(thisMonthVisibleCount, monthEntries.length)).map((entry) => {
                const s = entryRawServices(entry) * 0.035 * (1 + globalMultiplier)
                const b = entryRawBase(entry) * (1 + globalMultiplier)
                const t = entryTrading(entry)
                const tea = entryTea(entry)
                const total = s + b + t + tea
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between p-3 rounded-2xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {new Date(entry.date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400 flex-wrap">
                        <span style={{ color: SERVICES_COLOR }}>S {s.toFixed(0)}</span>
                        <span className="text-slate-600">·</span>
                        <span style={{ color: BASE_COLOR }}>B {b.toFixed(0)}</span>
                        <span className="text-slate-600">·</span>
                        <span style={{ color: TRADING_COLOR }}>T {t.toFixed(0)}</span>
                        {tea > 0 && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span style={{ color: TEA_COLOR }}>Te {tea.toFixed(0)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <div className="text-base font-bold text-white tabular-nums">{total.toFixed(2)}</div>
                      <div className="text-[10px] text-slate-500">UAH</div>
                    </div>
                  </li>
                )
              })}

              {monthEntries.length > thisMonthVisibleCount && (
                <li>
                  <button
                    type="button"
                    onClick={() => setThisMonthVisibleCount((c) => c + 4)}
                    className="w-full relative flex items-center justify-between p-3 rounded-2xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-colors overflow-hidden"
                    aria-label="Show more shifts"
                  >
                    {/* Blurred preview of the next (hidden) shift */}
                    <div className="flex items-center justify-between w-full gap-3">
                      <div className="min-w-0 blur-[2px] opacity-60">
                        <div className="text-sm font-medium text-white">
                          {new Date(monthEntries[thisMonthVisibleCount].date).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-400">
                          +{Math.min(4, monthEntries.length - thisMonthVisibleCount)} more
                        </div>
                      </div>
                      <div className="shrink-0 blur-[2px] opacity-60 text-right">
                        <div className="text-base font-bold text-white tabular-nums">••••</div>
                        <div className="text-[10px] text-slate-500">UAH</div>
                      </div>
                    </div>

                    {/* Unblurred affordance */}
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-300">
                      More <ChevronDown className="w-4 h-4" />
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      {/* Floating Action Button — quick access to Shift Details */}
      <button
        type="button"
        onClick={openShiftModal}
        aria-label="Add shift"
        className="fixed bottom-5 right-5 z-40 h-14 w-14 rounded-2xl bg-blue-500 text-white shadow-[0_0_28px_-6px_rgba(59,130,246,0.85),0_10px_26px_-10px_rgba(0,0,0,0.7)] border border-blue-300/30 hover:bg-blue-400 active:scale-[0.98] transition-all flex items-center justify-center"
      >
        <span className="sr-only">Add shift</span>
        <Briefcase className="w-5 h-5" />
      </button>

      {shiftModalOpen && (
        <ShiftDetailsModal
          selectedDate={selectedDate}
          draftTotal={draftTotal}
          justSaved={justSaved}
          currentRecord={currentRecord}
          presets={presets}
          onClose={() => setShiftModalOpen(false)}
          onUpdateRecord={updateRecord}
          onConfirmShift={() => {
            confirmShift()
            if (afterSaveBehavior === "close") {
              setShiftModalOpen(false)
              return
            }
            if (afterSaveBehavior === "stayNextDay") {
              const today = new Date(selectedDate)
              const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
              setSelectedDate(next.toISOString().split("T")[0])
            }
            // Default (staySameDayClear): keep modal open; confirmShift already clears inputs.
            // Refocus the first input for fast multi-entry.
            globalThis.setTimeout(() => shiftModalServicesInputRef.current?.focus(), 50)
          }}
          servicesInputRef={shiftModalServicesInputRef}
        />
      )}

      {calendarOpen && (
        <CalendarModal
          selectedDate={selectedDate}
          dayTotals={dayTotals}
          onClose={() => setCalendarOpen(false)}
          onSelectDate={(d) => setSelectedDate(d)}
          onOpenShift={(d) => {
            setSelectedDate(d)
            setCalendarOpen(false)
            openShiftModal()
          }}
        />
      )}

      {historyOpen && (
        <HistoryModal
          history={history}
          monthKey={historyMonth}
          globalMultiplier={globalMultiplier}
          onChangeMonth={setHistoryMonth}
          onClose={() => setHistoryOpen(false)}
          onDelete={deleteEntry}
          onEdit={editEntry}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          monthLabel={selectedMonthLabel}
          servicesGoal={currentGoal}
          onSaveGoal={updateServicesGoal}
          autoMultiplier={autoMultiplier}
          onToggleAutoMultiplier={updateAutoMultiplier}
          forecastPct={forecastPct}
          layoutMode={layoutMode}
          onChangeLayoutMode={updateLayoutMode}
          afterSaveBehavior={afterSaveBehavior}
          onChangeAfterSaveBehavior={updateAfterSaveBehavior}
          presets={presets}
          onChangePresets={updatePresets}
          backups={backups}
          onRestoreBackup={(b) => {
            applySnapshot(b.data)
            toast("Backup restored", { description: new Date(b.createdAt).toLocaleString() })
          }}
          onDeleteAllBackups={() => {
            setBackups([])
            localStorage.setItem(BACKUPS_KEY, JSON.stringify([]))
            toast("Backups deleted")
          }}
          onClose={() => setSettingsOpen(false)}
          onExport={exportData}
          onImport={triggerImport}
        />
      )}
    </div>
  )
}

function MetricChip({
  label,
  value,
  color,
  fraction,
  icon,
  multiplier = 0,
  showMultiplierDelta = false,
}: {
  label: string
  value: number
  color: string
  fraction: number
  icon: React.ReactNode
  multiplier?: number
  showMultiplierDelta?: boolean
}) {
  // The mini progress bar shows this card's share of the monthly total. When the
  // multiplier is non-zero AND this is a multiplier-affected card (Services / Base Rate),
  // we visually break out the delta:
  //   - Positive multiplier: split the colored fill so the bonus tail is shown in CYAN
  //     (biryuza) with a strong neon halo — distinct from the green Base Rate color.
  //   - Negative multiplier: append a muted-red diagonal-striped segment after the
  //     colored fill to represent the deducted amount (the "phantom loss").
  const hasDelta = showMultiplierDelta && multiplier !== 0 && value > 0
  const isPositive = multiplier > 0
  const isNegative = multiplier < 0

  // Width of the value segment in % of total bar. Keeps the existing min-width behavior.
  const valueWidthPct = Math.max(fraction * 100, value > 0 ? 6 : 0)

  // value already has the multiplier baked in (value = raw * (1 + m)).
  // For positive m: split valueWidthPct into base (= valueWidthPct / (1+m)) and bonus tail.
  // For negative m: keep colored fill at valueWidthPct, append red striped loss segment
  //   sized so colored + loss = "what would-have-been" without the negative multiplier.
  let baseWidthPct = valueWidthPct
  let bonusWidthPct = 0
  let lossWidthPct = 0
  let deltaUah = 0

  if (hasDelta) {
    if (isPositive) {
      baseWidthPct = valueWidthPct / (1 + multiplier)
      bonusWidthPct = Math.max(valueWidthPct - baseWidthPct, 0)
      // Bonus UAH = final − base = value − value/(1+m)
      deltaUah = value - value / (1 + multiplier)
    } else if (isNegative) {
      // multiplier is negative → (-multiplier)/(1+multiplier) > 0
      lossWidthPct = (valueWidthPct * -multiplier) / (1 + multiplier)
      // Cap so colored + loss never exceeds 100% of the bar width
      lossWidthPct = Math.min(lossWidthPct, Math.max(0, 100 - valueWidthPct))
      // Loss UAH = (would-have-been) − final = value/(1+m) − value, rendered as negative
      deltaUah = -((value * -multiplier) / (1 + multiplier))
    }
  }

  return (
    <div className="rounded-2xl bg-white/[0.04] backdrop-blur-xl border border-white/10 p-3">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium" style={{ color }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 flex-wrap leading-none">
        <span className="text-base font-bold text-white tabular-nums">{fmtUah(value)}</span>
        <span className="text-[10px] font-medium text-slate-500">UAH</span>
        {hasDelta && deltaUah !== 0 && (
          <span
            className="text-[10px] font-bold tabular-nums"
            style={{
              color: isPositive ? BONUS_COLOR : "#f87171",
              textShadow: isPositive ? `0 0 8px ${BONUS_GLOW}` : undefined,
            }}
          >
            {`(${deltaUah > 0 ? "+" : "-"}${fmtUah(Math.abs(deltaUah))})`}
          </span>
        )}
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-white/5 overflow-hidden flex">
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${baseWidthPct}%`,
            background: color,
            boxShadow: `0 0 10px ${color}`,
          }}
        />
        {bonusWidthPct > 0 && (
          <div
            className="h-full transition-all duration-500"
            style={{
              width: `${bonusWidthPct}%`,
              // Pale-cyan core gives the "neon tube" look; the halo is layered shadows
              // in cyan-300/500 so the segment glows even on dark backgrounds.
              background: "linear-gradient(180deg, #ecfeff 0%, #a5f3fc 60%, #22d3ee 100%)",
              boxShadow:
                "0 0 4px #ecfeff, 0 0 8px #67e8f9, 0 0 14px #06b6d4, 0 0 22px rgba(6,182,212,0.7)",
            }}
            aria-label={`Multiplier bonus +${Math.round(multiplier * 100)}%`}
          />
        )}
        {lossWidthPct > 0 && (
          <div
            className="h-full transition-all duration-500"
            style={{
              width: `${lossWidthPct}%`,
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(239,68,68,0.85) 0 3px, rgba(239,68,68,0.25) 3px 6px)",
            }}
            aria-label={`Multiplier penalty ${Math.round(multiplier * 100)}%`}
          />
        )}
      </div>
    </div>
  )
}

function HistoryModal({
  history,
  monthKey,
  globalMultiplier,
  onChangeMonth,
  onClose,
  onDelete,
  onEdit,
}: {
  history: HistoryEntry[]
  monthKey: string
  globalMultiplier: number
  onChangeMonth: (m: string) => void
  onClose: () => void
  onDelete: (id: string) => void
  onEdit: (entry: HistoryEntry) => void
}) {
  const [year, month] = monthKey.split("-").map(Number)
  const label = `${MONTH_NAMES[month - 1]} ${year}`
  const [rangeMode, setRangeMode] = useState<"month" | "lastMonth" | "all" | "custom">("month")
  const [customStart, setCustomStart] = useState("")
  const [customEnd, setCustomEnd] = useState("")
  const [minTotal, setMinTotal] = useState("")
  const [maxTotal, setMaxTotal] = useState("")
  const [baseFilter, setBaseFilter] = useState<"any" | "with" | "without">("any")
  const [sortMode, setSortMode] = useState<"dateDesc" | "dateAsc" | "totalDesc" | "totalAsc">("dateDesc")
  const [query, setQuery] = useState("")

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1)
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    onChangeMonth(next)
  }

  const entryTotal = (e: HistoryEntry) => {
    const s = entryRawServices(e) * 0.035 * (1 + globalMultiplier)
    const b = entryRawBase(e) * (1 + globalMultiplier)
    const t = entryTrading(e)
    const tea = entryTea(e)
    return s + b + t + tea
  }

  const baseEntries = useMemo(() => {
    if (rangeMode === "all") return history
    if (rangeMode === "month") return history.filter((e) => monthKeyOf(e.date) === monthKey)
    if (rangeMode === "lastMonth") {
      const d = new Date(year, month - 2, 1)
      const prevKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      return history.filter((e) => monthKeyOf(e.date) === prevKey)
    }
    // custom
    if (!customStart || !customEnd) return history
    const start = new Date(customStart).getTime()
    const end = new Date(customEnd).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end)) return history
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    return history.filter((e) => {
      const t = new Date(e.date).getTime()
      return t >= lo && t <= hi
    })
  }, [rangeMode, history, monthKey, year, month, customStart, customEnd])

  const entries = useMemo(() => {
    const min = Number(minTotal)
    const max = Number(maxTotal)
    const hasMin = minTotal.trim() !== "" && Number.isFinite(min)
    const hasMax = maxTotal.trim() !== "" && Number.isFinite(max)
    const q = query.trim().toLowerCase()

    const filtered = baseEntries.filter((e) => {
      if (baseFilter === "with" && entryRawBase(e) <= 0) return false
      if (baseFilter === "without" && entryRawBase(e) > 0) return false
      const total = entryTotal(e)
      if (hasMin && total < min) return false
      if (hasMax && total > max) return false
      if (q) {
        const dateLabel = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
        if (!dateLabel.toLowerCase().includes(q) && !e.date.toLowerCase().includes(q)) return false
      }
      return true
    })

    const sorted = [...filtered].sort((a, b) => {
      if (sortMode === "dateAsc") return a.date.localeCompare(b.date) || a.savedAt - b.savedAt
      if (sortMode === "dateDesc") return b.date.localeCompare(a.date) || b.savedAt - a.savedAt
      if (sortMode === "totalAsc") return entryTotal(a) - entryTotal(b)
      return entryTotal(b) - entryTotal(a)
    })
    return sorted
  }, [baseEntries, baseFilter, minTotal, maxTotal, query, sortMode, globalMultiplier])

  const totals = useMemo(() => {
    const raw = entries.reduce(
      (acc, e) => {
        acc.servicesRaw += entryRawServices(e)
        acc.baseRaw += entryRawBase(e)
        acc.trading += entryTrading(e)
        acc.tea += entryTea(e)
        return acc
      },
      { servicesRaw: 0, baseRaw: 0, trading: 0, tea: 0 },
    )
    const services = raw.servicesRaw * 0.035 * (1 + globalMultiplier)
    const base = raw.baseRaw * (1 + globalMultiplier)
    return {
      services,
      base,
      trading: raw.trading,
      tea: raw.tea,
      total: services + base + raw.trading + raw.tea,
    }
  }, [entries, globalMultiplier])

  const avg = entries.length > 0 ? totals.total / entries.length : 0

  // Available months from history (descending)
  const availableMonths = useMemo(() => {
    const set = new Set<string>()
    history.forEach((e) => set.add(monthKeyOf(e.date)))
    set.add(monthKey)
    set.add(new Date().toISOString().slice(0, 7))
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1))
  }, [history, monthKey])

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#0b1226] border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shrink-0">
              <HistoryIcon className="w-4 h-4 text-blue-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">Shift History</h3>
              <p className="text-[11px] text-slate-400 truncate">Edit or delete shifts</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              aria-label="Close history"
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-slate-300" />
            </button>
          </div>
        </div>

        {/* Month selector */}
        <div className="p-4 border-b border-white/10 shrink-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
              className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-slate-300" />
            </button>
            <select
              value={monthKey}
              onChange={(e) => onChangeMonth(e.target.value)}
              className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-sm font-semibold text-white text-center outline-none [color-scheme:dark]"
            >
              {availableMonths.map((m) => {
                const [y, mm] = m.split("-").map(Number)
                return (
                  <option key={m} value={m} className="bg-[#0b1226]">
                    {MONTH_NAMES[mm - 1]} {y}
                  </option>
                )
              })}
            </select>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
              className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-slate-300" />
            </button>
          </div>

          {/* Month summary */}
          <div className="rounded-2xl bg-gradient-to-br from-blue-600/15 to-transparent border border-white/10 p-3">
            <div className="text-[11px] uppercase tracking-wider text-blue-200/80 font-medium flex items-center gap-1.5 flex-wrap">
              <span>{label}</span>
              <span className="text-slate-600">·</span>
              <span>
                {entries.length} {entries.length === 1 ? "shift" : "shifts"}
              </span>
              {entries.length > 0 && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400 normal-case tracking-normal">
                    avg <span className="font-semibold text-slate-200 tabular-nums">{avg.toFixed(0)}</span>
                  </span>
                </>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-white tabular-nums">{totals.total.toFixed(2)}</span>
              <span className="text-xs font-semibold text-blue-200/70">UAH</span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
              <div>
                <div className="text-slate-400">Services</div>
                <div className="font-bold tabular-nums" style={{ color: SERVICES_COLOR }}>
                  {totals.services.toFixed(0)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Base</div>
                <div className="font-bold tabular-nums" style={{ color: BASE_COLOR }}>
                  {totals.base.toFixed(0)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Trading</div>
                <div className="font-bold tabular-nums" style={{ color: TRADING_COLOR }}>
                  {totals.trading.toFixed(0)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">Tea</div>
                <div className="font-bold tabular-nums" style={{ color: TEA_COLOR }}>
                  {totals.tea.toFixed(0)}
                </div>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={rangeMode}
                onChange={(e) => setRangeMode(e.target.value as any)}
                className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
              >
                <option value="month">This month</option>
                <option value="lastMonth">Last month</option>
                <option value="all">All time</option>
                <option value="custom">Custom</option>
              </select>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as any)}
                className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
              >
                <option value="dateDesc">Date ↓</option>
                <option value="dateAsc">Date ↑</option>
                <option value="totalDesc">Total ↓</option>
                <option value="totalAsc">Total ↑</option>
              </select>
            </div>

            {rangeMode === "custom" && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
                />
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
                />
              </div>
            )}

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search date…"
              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none placeholder:text-slate-600"
            />

            <div className="grid grid-cols-3 gap-2">
              <input
                value={minTotal}
                onChange={(e) => setMinTotal(e.target.value)}
                inputMode="decimal"
                placeholder="Min total"
                className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none placeholder:text-slate-600 tabular-nums"
              />
              <input
                value={maxTotal}
                onChange={(e) => setMaxTotal(e.target.value)}
                inputMode="decimal"
                placeholder="Max total"
                className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none placeholder:text-slate-600 tabular-nums"
              />
              <select
                value={baseFilter}
                onChange={(e) => setBaseFilter(e.target.value as any)}
                className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
              >
                <option value="any">Base: any</option>
                <option value="with">Base: on</option>
                <option value="without">Base: off</option>
              </select>
            </div>

            <div className="text-[10px] text-slate-500">
              Showing <span className="text-slate-300 font-semibold">{entries.length}</span> shifts
            </div>
          </div>
        </div>

        {/* Entries list */}
        <div className="flex-1 overflow-y-auto p-4">
          {entries.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm">No shifts in {label}.</div>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => {
                const s = entryRawServices(entry) * 0.035 * (1 + globalMultiplier)
                const b = entryRawBase(entry) * (1 + globalMultiplier)
                const t = entryTrading(entry)
                const tea = entryTea(entry)
                const total = s + b + t + tea
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 p-3 rounded-2xl bg-white/[0.03] border border-white/5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white">
                        {new Date(entry.date).toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400 flex-wrap">
                        <span style={{ color: SERVICES_COLOR }}>S {s.toFixed(0)}</span>
                        <span className="text-slate-600">·</span>
                        <span style={{ color: BASE_COLOR }}>B {b.toFixed(0)}</span>
                        <span className="text-slate-600">·</span>
                        <span style={{ color: TRADING_COLOR }}>T {t.toFixed(0)}</span>
                        {tea > 0 && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span style={{ color: TEA_COLOR }}>Te {tea.toFixed(0)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-bold text-white tabular-nums leading-none">
                        {total.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-slate-500">UAH</div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        type="button"
                        aria-label="Edit shift"
                        onClick={() => onEdit(entry)}
                        className="w-7 h-7 rounded-lg bg-blue-500/15 hover:bg-blue-500/30 border border-blue-400/30 flex items-center justify-center transition-colors"
                      >
                        <Pencil className="w-3 h-3 text-blue-200" />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete shift"
                        onClick={() => onDelete(entry.id)}
                        className="w-7 h-7 rounded-lg bg-red-500/15 hover:bg-red-500/30 border border-red-400/30 flex items-center justify-center transition-colors"
                      >
                        <Trash2 className="w-3 h-3 text-red-300" />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function CalendarModal({
  selectedDate,
  dayTotals,
  onClose,
  onSelectDate,
  onOpenShift,
}: {
  selectedDate: string
  dayTotals: Record<string, number>
  onClose: () => void
  onSelectDate: (dateStr: string) => void
  onOpenShift: (dateStr: string) => void
}) {
  const selected = useMemo(() => new Date(selectedDate), [selectedDate])

  const { low, mid, high } = useMemo(() => {
    const entries = Object.entries(dayTotals).filter(([, v]) => v > 0)
    if (entries.length === 0) return { low: [] as Date[], mid: [] as Date[], high: [] as Date[] }
    const vals = entries.map(([, v]) => v).sort((a, b) => a - b)
    const p33 = vals[Math.floor(vals.length * 0.33)] ?? vals[0]
    const p66 = vals[Math.floor(vals.length * 0.66)] ?? vals[vals.length - 1]
    const lowDates: Date[] = []
    const midDates: Date[] = []
    const highDates: Date[] = []
    for (const [k, v] of entries) {
      const d = new Date(k)
      if (v <= p33) lowDates.push(d)
      else if (v <= p66) midDates.push(d)
      else highDates.push(d)
    }
    return { low: lowDates, mid: midDates, high: highDates }
  }, [dayTotals])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Calendar"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#0b1226] border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shrink-0">
              <Calendar className="w-4 h-4 text-blue-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">Calendar</h3>
              <p className="text-[11px] text-slate-400 truncate">Tap a day to select</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close calendar"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4 text-slate-300" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3">
            <DayPicker
              mode="single"
              selected={selected}
              onSelect={(d) => {
                if (!d) return
                const dateStr = d.toISOString().split("T")[0]
                onSelectDate(dateStr)
              }}
              modifiers={{ low, mid, high }}
              modifiersClassNames={{
                low: "bg-blue-500/15 text-blue-100 rounded-xl",
                mid: "bg-blue-500/30 text-blue-50 rounded-xl",
                high: "bg-blue-500/55 text-white rounded-xl",
              }}
              className="text-slate-200"
              weekStartsOn={1}
            />
            <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
              <span>Legend</span>
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500/15 border border-white/10" />
                  low
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500/30 border border-white/10" />
                  mid
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500/55 border border-white/10" />
                  high
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-white/10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenShift(selectedDate)}
            className="flex-1 py-3 rounded-2xl bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/30 text-sm font-semibold text-blue-200 transition-colors"
          >
            Open shift
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-semibold text-slate-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsModal({
  monthLabel,
  servicesGoal,
  onSaveGoal,
  autoMultiplier,
  onToggleAutoMultiplier,
  forecastPct,
  layoutMode,
  onChangeLayoutMode,
  afterSaveBehavior,
  onChangeAfterSaveBehavior,
  presets,
  onChangePresets,
  backups,
  onRestoreBackup,
  onDeleteAllBackups,
  onClose,
  onExport,
  onImport,
}: {
  monthLabel: string
  servicesGoal: number
  onSaveGoal: (next: number) => void
  autoMultiplier: boolean
  onToggleAutoMultiplier: (next: boolean) => void
  forecastPct: number
  layoutMode: LayoutMode
  onChangeLayoutMode: (next: LayoutMode) => void
  afterSaveBehavior: AfterSaveBehavior
  onChangeAfterSaveBehavior: (next: AfterSaveBehavior) => void
  presets: Preset[]
  onChangePresets: (next: Preset[]) => void
  backups: BackupSnapshot[]
  onRestoreBackup: (b: BackupSnapshot) => void
  onDeleteAllBackups: () => void
  onClose: () => void
  onExport: () => void
  onImport: () => void
}) {
  const [goalInput, setGoalInput] = useState(String(servicesGoal))

  // Keep input in sync if month/goal changes externally while modal is open
  useEffect(() => {
    setGoalInput(String(servicesGoal))
  }, [servicesGoal])

  const commitGoal = () => {
    const n = Math.max(0, Number(goalInput) || 0)
    onSaveGoal(n)
  }

  const projectedMultPct = Math.round(autoMultiplierFor(forecastPct) * 100)
  const projectedTone =
    projectedMultPct > 0 ? "text-emerald-300" : projectedMultPct < 0 ? "text-red-300" : "text-blue-200"

  const upsertPreset = (id: string, patch: Partial<Preset>) => {
    onChangePresets(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const addPreset = () => {
    const next: Preset = {
      id: `p-${Date.now()}`,
      name: "New preset",
      target: "servicesRaw",
      mode: "replace",
      value: "0",
    }
    onChangePresets([next, ...presets])
  }

  const removePreset = (id: string) => {
    onChangePresets(presets.filter((p) => p.id !== id))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#0b1226] border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shrink-0">
              <SettingsIcon className="w-4 h-4 text-blue-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">Settings</h3>
              <p className="text-[11px] text-slate-400 truncate">{monthLabel}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4 text-slate-300" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-5">
          {/* Monthly Services Goal */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-blue-300" />
              <label htmlFor="services-goal" className="text-sm font-semibold text-white">
                Monthly Services Goal
              </label>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Target amount of <span className="text-slate-200 font-medium">raw services</span> for the month
              (in UAH, before the 3.5% rate). Drives the dashboard progress bar and the forecasted multiplier.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="services-goal"
                type="number"
                inputMode="decimal"
                min={0}
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                onBlur={commitGoal}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitGoal()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                className="flex-1 px-3 py-3 bg-white/5 border border-white/10 rounded-2xl text-base text-white tabular-nums placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500/60 focus:border-blue-500/60 outline-none transition-all"
                placeholder="50000"
              />
              <span className="text-xs font-semibold text-slate-400">UAH</span>
            </div>
          </div>

          {/* Auto-multiplier toggle */}
          <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-3.5 space-y-3">
            <button
              type="button"
              onClick={() => onToggleAutoMultiplier(!autoMultiplier)}
              className="w-full flex items-center justify-between gap-3"
              aria-pressed={autoMultiplier}
            >
              <div className="flex flex-col items-start text-left min-w-0">
                <span className="text-sm font-semibold text-white flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-blue-300" />
                  Auto-calculate Multiplier
                </span>
                <span className="text-[11px] text-slate-400 leading-snug">
                  Locks the multiplier to a value derived from the forecasted % of your services goal.
                </span>
              </div>
              <div
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                  autoMultiplier ? "bg-blue-500" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-5 h-5 rounded-full bg-white transition-transform ${
                    autoMultiplier ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </div>
            </button>

            {autoMultiplier && (
              <div className="rounded-xl bg-blue-500/10 border border-blue-400/20 p-2.5 text-[11px] text-slate-300 leading-relaxed">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-slate-400">Forecast</span>
                  <span className="font-bold tabular-nums text-blue-200">{Math.round(forecastPct)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Auto multiplier</span>
                  <span className={`font-bold tabular-nums ${projectedTone}`}>
                    {projectedMultPct > 0 ? "+" : ""}
                    {projectedMultPct}%
                  </span>
                </div>
              </div>
            )}

            <div className="text-[10px] text-slate-500 leading-relaxed">
              Bands: &lt;81% → -20%, 81–90% → -10%, 91–109% → 0%, 110–119% → +10%, ≥120% → +20%.
            </div>
          </div>

          {/* Dashboard layout — segmented control: Compact (legend visible) vs Detailed (cards visible) */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-blue-300" />
              <span className="text-sm font-semibold text-white">Dashboard Layout</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              <span className="text-slate-200 font-medium">Compact</span> shows a legend next to the chart and
              hides the summary cards. <span className="text-slate-200 font-medium">Detailed</span> hides the
              legend and shows the full summary cards row.
            </p>
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-white/5 border border-white/10">
              <button
                type="button"
                onClick={() => onChangeLayoutMode("compact")}
                aria-pressed={layoutMode === "compact"}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all ${
                  layoutMode === "compact"
                    ? "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <Rows3 className="w-3.5 h-3.5" />
                Compact
              </button>
              <button
                type="button"
                onClick={() => onChangeLayoutMode("detailed")}
                aria-pressed={layoutMode === "detailed"}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all ${
                  layoutMode === "detailed"
                    ? "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Detailed
              </button>
            </div>
          </div>

          {/* After save behavior */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-blue-300" />
              <span className="text-sm font-semibold text-white">After saving a shift</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Choose what happens after you tap <span className="text-slate-200 font-medium">Confirm Shift</span>.
            </p>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-2xl bg-white/5 border border-white/10">
              <button
                type="button"
                onClick={() => onChangeAfterSaveBehavior("staySameDayClear")}
                aria-pressed={afterSaveBehavior === "staySameDayClear"}
                className={`py-2 rounded-xl text-[11px] font-semibold transition-all ${
                  afterSaveBehavior === "staySameDayClear"
                    ? "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => onChangeAfterSaveBehavior("stayNextDay")}
                aria-pressed={afterSaveBehavior === "stayNextDay"}
                className={`py-2 rounded-xl text-[11px] font-semibold transition-all ${
                  afterSaveBehavior === "stayNextDay"
                    ? "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                Next day
              </button>
              <button
                type="button"
                onClick={() => onChangeAfterSaveBehavior("close")}
                aria-pressed={afterSaveBehavior === "close"}
                className={`py-2 rounded-xl text-[11px] font-semibold transition-all ${
                  afterSaveBehavior === "close"
                    ? "bg-blue-500/90 text-white shadow-[0_0_18px_-4px_rgba(59,130,246,0.7)]"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                Close
              </button>
            </div>
          </div>

          {/* Presets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Presets</div>
              <button
                type="button"
                onClick={addPreset}
                className="h-8 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-slate-200 transition-colors"
              >
                Add
              </button>
            </div>
            <div className="space-y-2">
              {presets.length === 0 ? (
                <div className="text-[11px] text-slate-500">No presets yet.</div>
              ) : (
                presets.map((p) => (
                  <div key={p.id} className="rounded-2xl bg-white/[0.04] border border-white/10 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={p.name}
                        onChange={(e) => upsertPreset(p.id, { name: e.target.value })}
                        className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-sm font-semibold text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => removePreset(p.id)}
                        className="w-9 h-9 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 flex items-center justify-center transition-colors"
                        aria-label="Remove preset"
                      >
                        <Trash2 className="w-4 h-4 text-red-300" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        value={p.target}
                        onChange={(e) => upsertPreset(p.id, { target: e.target.value as PresetTarget })}
                        className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
                      >
                        <option value="servicesRaw">Services</option>
                        <option value="tradeEarnings">Trading</option>
                        <option value="teaEarnings">Tea</option>
                      </select>
                      <select
                        value={p.mode}
                        onChange={(e) => upsertPreset(p.id, { mode: e.target.value as PresetMode })}
                        className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none [color-scheme:dark]"
                      >
                        <option value="replace">Replace</option>
                        <option value="append">Append</option>
                      </select>
                      <input
                        value={p.value}
                        onChange={(e) => upsertPreset(p.id, { value: e.target.value })}
                        className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-[12px] font-semibold text-white outline-none tabular-nums"
                        inputMode="decimal"
                      />
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Applies to{" "}
                      {p.target === "servicesRaw" ? "Services" : p.target === "tradeEarnings" ? "Trading" : "Tea"} ·{" "}
                      {p.mode === "replace" ? "replaces" : "appends"} value
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Backups */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Backups</div>
              <button
                type="button"
                onClick={onDeleteAllBackups}
                className="h-8 px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-[11px] font-semibold text-red-200 transition-colors"
                disabled={backups.length === 0}
              >
                Delete all
              </button>
            </div>
            {backups.length === 0 ? (
              <div className="text-[11px] text-slate-500">No backups yet. They’re created automatically.</div>
            ) : (
              <div className="space-y-2">
                {backups.slice(0, 6).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onRestoreBackup(b)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                  >
                    <div className="text-left min-w-0">
                      <div className="text-[12px] font-semibold text-white truncate">
                        {new Date(b.createdAt).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {b.data.history.length} shifts · {Object.keys(b.data.drafts || {}).length} drafts
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold text-blue-200">Restore</span>
                  </button>
                ))}
                <div className="text-[10px] text-slate-500">Keeps the latest 10 backups.</div>
              </div>
            )}
          </div>

          {/* Data management */}
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Data</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onImport}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-semibold text-slate-200 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Import JSON
              </button>
              <button
                type="button"
                onClick={onExport}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-2xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 text-xs font-semibold text-blue-200 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                Export JSON
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ShiftDetailsModal({
  selectedDate,
  draftTotal,
  justSaved,
  currentRecord,
  presets,
  onClose,
  onUpdateRecord,
  onConfirmShift,
  servicesInputRef,
}: {
  selectedDate: string
  draftTotal: number
  justSaved: boolean
  currentRecord: DraftRecord
  presets: Preset[]
  onClose: () => void
  onUpdateRecord: (field: keyof DraftRecord, value: any) => void
  onConfirmShift: () => void
  servicesInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const tradingInputRef = useRef<HTMLInputElement>(null)
  const teaInputRef = useRef<HTMLInputElement>(null)

  type CalcTarget = "servicesRaw" | "tradeEarnings" | "teaEarnings"
  const [calcTarget, setCalcTarget] = useState<CalcTarget>("servicesRaw")
  const [calcError, setCalcError] = useState<string | null>(null)

  const activeExpr = useMemo(() => {
    if (calcTarget === "servicesRaw") return String(currentRecord.servicesRaw ?? "")
    if (calcTarget === "tradeEarnings") return String(currentRecord.tradeEarnings ?? "")
    return String(currentRecord.teaEarnings ?? "")
  }, [calcTarget, currentRecord.servicesRaw, currentRecord.tradeEarnings, currentRecord.teaEarnings])

  const activePreview = useMemo(() => {
    const expr = activeExpr.trim()
    if (!expr) return null
    if (!/[+\-*/()]/.test(expr)) return null
    const res = evalMiniExpr(expr)
    if (!res.ok) return null
    return res.value
  }, [activeExpr])

  const focusTarget = () => {
    if (calcTarget === "servicesRaw") servicesInputRef.current?.focus()
    if (calcTarget === "tradeEarnings") tradingInputRef.current?.focus()
    if (calcTarget === "teaEarnings") teaInputRef.current?.focus()
  }

  const updateActive = (next: string) => {
    setCalcError(null)
    onUpdateRecord(calcTarget, next)
  }

  const appendToActive = (s: string) => updateActive((activeExpr + s).slice(0, 32))
  const backspaceActive = () => updateActive(activeExpr.slice(0, -1))
  const clearActive = () => updateActive("")

  const applyPreset = (p: Preset) => {
    const current =
      p.target === "servicesRaw"
        ? String(currentRecord.servicesRaw ?? "")
        : p.target === "tradeEarnings"
          ? String(currentRecord.tradeEarnings ?? "")
          : String(currentRecord.teaEarnings ?? "")
    const next = p.mode === "append" ? (current + p.value).slice(0, 32) : p.value
    onUpdateRecord(p.target, next)
    setCalcTarget(p.target)
    globalThis.setTimeout(() => {
      if (p.target === "servicesRaw") servicesInputRef.current?.focus()
      if (p.target === "tradeEarnings") tradingInputRef.current?.focus()
      if (p.target === "teaEarnings") teaInputRef.current?.focus()
    }, 0)
  }

  // iOS: prevent background rubber-band scroll without blurring inputs.
  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      const panel = panelRef.current
      const target = e.target as Node | null
      if (!panel || !target) return
      if (!panel.contains(target)) e.preventDefault()
    }
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => document.removeEventListener("touchmove", onTouchMove)
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Shift details"
      className="fixed inset-0 z-50 flex justify-end sm:items-center sm:justify-center bg-black/70 backdrop-blur-sm overflow-hidden overscroll-none min-h-[100dvh]"
      onClick={onClose}
      onTouchMove={(e) => e.preventDefault()}
    >
      <div
        className="w-full sm:max-w-md max-h-[calc(100dvh-16px)] sm:max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#0b1226] border border-white/10 shadow-2xl overflow-hidden mt-auto"
        onClick={(e) => e.stopPropagation()}
        ref={panelRef}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shrink-0">
              <Briefcase className="w-4 h-4 text-blue-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">Shift Details</h3>
              <p className="text-[11px] text-slate-400 truncate">{selectedDate}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onConfirmShift}
              disabled={draftTotal <= 0}
              aria-label="Confirm shift"
              className={`h-8 px-3 rounded-xl text-[11px] font-semibold transition-all inline-flex items-center justify-center gap-1.5 border ${
                draftTotal > 0
                  ? "bg-blue-500/25 hover:bg-blue-500/35 text-blue-100 border-blue-300/30 shadow-[0_0_18px_-6px_rgba(59,130,246,0.8)] active:scale-[0.99]"
                  : "bg-white/5 text-slate-500 border-white/10 cursor-not-allowed"
              }`}
              title={draftTotal > 0 ? "Confirm Shift" : "Enter an amount to confirm"}
            >
              <CheckCircle2 className="w-4 h-4" />
              {justSaved ? "Saved" : "Confirm"}
            </button>

            <button
              type="button"
              aria-label="Close shift details"
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-slate-300" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400 tabular-nums">Today: {draftTotal.toFixed(2)} UAH</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-slate-400">
                Total services amount <span className="text-slate-500">(× 3.5%)</span>
              </label>
              <button
                type="button"
                onClick={() => onUpdateRecord("hasBaseRate", !currentRecord.hasBaseRate)}
                aria-pressed={currentRecord.hasBaseRate}
                title={
                  currentRecord.hasBaseRate
                    ? "Base rate ON — adds +400 UAH (multiplier applies). Click to disable."
                    : "Base rate OFF — click to add +400 UAH base shift rate."
                }
                className={`group flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full border transition-all ${
                  currentRecord.hasBaseRate
                    ? "border-cyan-300/40 bg-cyan-400/10 shadow-[0_0_14px_-4px_rgba(34,211,238,0.7)]"
                    : "border-white/10 bg-white/5 hover:border-white/20"
                }`}
              >
                <span className="relative flex items-center justify-center w-3 h-3">
                  {currentRecord.hasBaseRate && (
                    <span className="absolute inset-0 rounded-full bg-cyan-400/60 animate-ping" />
                  )}
                  <span
                    className={`relative w-2 h-2 rounded-full transition-colors ${
                      currentRecord.hasBaseRate ? "bg-cyan-300" : "bg-slate-600 group-hover:bg-slate-500"
                    }`}
                    style={
                      currentRecord.hasBaseRate
                        ? { boxShadow: "0 0 8px rgba(34,211,238,0.95), 0 0 14px rgba(6,182,212,0.7)" }
                        : undefined
                    }
                  />
                </span>
                <span
                  className={`text-[10px] font-semibold tabular-nums tracking-tight ${
                    currentRecord.hasBaseRate ? "text-cyan-200" : "text-slate-400"
                  }`}
                >
                  +400 UAH
                </span>
                <span className="text-[9px] text-slate-500 hidden sm:inline">base rate</span>
              </button>
            </div>
            <div className="relative">
              <input
                ref={servicesInputRef}
                autoFocus
                type="text"
                inputMode="decimal"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={currentRecord.servicesRaw}
                onFocus={() => {
                  setCalcTarget("servicesRaw")
                  setCalcError(null)
                }}
                onChange={(e) => onUpdateRecord("servicesRaw", e.target.value)}
                placeholder="0"
                className="w-full px-4 py-3 pr-20 bg-white/5 border border-white/10 rounded-2xl text-base text-white placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500/60 focus:border-blue-500/60 outline-none transition-all"
              />
              {calcTarget === "servicesRaw" && activePreview !== null && (
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold tabular-nums text-blue-200/70">
                  = {activePreview}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1">
                <Coins className="w-3 h-3" style={{ color: TRADING_COLOR }} />
                Trading
              </label>
              <div className="relative">
                <input
                  ref={tradingInputRef}
                  type="text"
                  inputMode="decimal"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={currentRecord.tradeEarnings}
                  onFocus={() => {
                    setCalcTarget("tradeEarnings")
                    setCalcError(null)
                  }}
                  onChange={(e) => onUpdateRecord("tradeEarnings", e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-3 pr-16 bg-white/5 border border-white/10 rounded-2xl text-base text-white placeholder:text-slate-600 focus:ring-2 focus:ring-amber-500/60 focus:border-amber-500/60 outline-none transition-all"
                />
                {calcTarget === "tradeEarnings" && activePreview !== null && (
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold tabular-nums text-amber-200/70">
                    = {activePreview}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 flex items-center gap-1">
                <Coffee className="w-3 h-3" style={{ color: TEA_COLOR }} />
                Tea (Tips)
              </label>
              <div className="relative">
                <input
                  ref={teaInputRef}
                  type="text"
                  inputMode="decimal"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={currentRecord.teaEarnings}
                  onFocus={() => {
                    setCalcTarget("teaEarnings")
                    setCalcError(null)
                  }}
                  onChange={(e) => onUpdateRecord("teaEarnings", e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-3 pr-16 bg-white/5 border border-white/10 rounded-2xl text-base text-white placeholder:text-slate-600 focus:ring-2 focus:ring-pink-500/60 focus:border-pink-500/60 outline-none transition-all"
                />
                {calcTarget === "teaEarnings" && activePreview !== null && (
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold tabular-nums text-pink-200/70">
                    = {activePreview}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Inline calculator bar (mobile-first) */}
          <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-slate-300">Inline calc</div>
              <div className="text-[10px] font-semibold text-slate-400">
                Target:{" "}
                <span className="text-slate-200">
                  {calcTarget === "servicesRaw" ? "Services" : calcTarget === "tradeEarnings" ? "Trading" : "Tea"}
                </span>
              </div>
            </div>

            {calcError && <div className="text-[11px] text-red-300">{calcError}</div>}

            <div className="grid grid-cols-6 gap-1.5">
              {[
                { k: "+", v: "+" },
                { k: "−", v: "-" },
                { k: "×", v: "*" },
                { k: "÷", v: "/" },
                { k: "(", v: "(" },
                { k: ")", v: ")" },
              ].map((b) => (
                <button
                  key={b.k}
                  type="button"
                  onClick={() => {
                    appendToActive(b.v)
                    focusTarget()
                  }}
                  className="h-10 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-semibold text-white transition-colors"
                >
                  {b.k}
                </button>
              ))}
            </div>
          </div>

          {presets.length > 0 && (
            <div className="rounded-2xl bg-white/[0.04] border border-white/10 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] font-semibold text-slate-300">Presets</div>
                <div className="text-[10px] font-semibold text-slate-500">tap to apply</div>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="shrink-0 h-10 px-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-slate-200 transition-colors"
                    title={`${p.mode === "append" ? "Append" : "Replace"} ${p.value}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className="hidden sm:block p-4 border-t border-white/10 shrink-0"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        >
          <button
            onClick={onConfirmShift}
            disabled={draftTotal <= 0}
            className={`relative w-full py-4 rounded-2xl font-semibold text-base transition-all flex items-center justify-center gap-2 ${
              draftTotal > 0
                ? "bg-blue-500 hover:bg-blue-400 text-white shadow-[0_0_30px_-4px_rgba(59,130,246,0.7),0_8px_24px_-8px_rgba(59,130,246,0.6)] active:scale-[0.98]"
                : "bg-slate-800 text-slate-600 cursor-not-allowed"
            }`}
          >
            {justSaved ? (
              <>
                <CheckCircle2 className="w-5 h-5" />
                Shift Saved
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5" />
                Confirm Shift
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
