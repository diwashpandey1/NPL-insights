import { CalendarDays, ChevronDown } from 'lucide-react'

export function SeasonSelector({ compact = false }: { compact?: boolean }) {
  return <label className={`season-select ${compact ? 'season-select--compact' : ''}`}>
    <CalendarDays size={15} aria-hidden="true" />
    {!compact && <span>Season</span>}
    <select aria-label="Season" defaultValue="2026">
      <option value="all">All seasons</option>
      <option value="2024">Season I · 2024</option>
      <option value="2025">Season II · 2025</option>
      <option value="2026">Season III · 2026</option>
    </select>
    <ChevronDown size={13} aria-hidden="true" />
  </label>
}
