import { useState } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { PlayerCard } from '../../components/sports/PlayerCard'

const roles = ['All roles', 'Batter', 'Bowler', 'All-rounder', 'Wicketkeeper']

export function PlayersPage() {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('All roles')
  const visibleCount = 0
  return <div className="page-stack">
    <SectionHeader eyebrow="PLAYER INDEX · SEASON III" title="The players" description="Find the batters, bowlers and all-rounders shaping Nepal’s premier T20 league." />
    <section className="directory-toolbar" aria-label="Player search and filters">
      <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search players" aria-label="Search players" /></label>
      <div className="role-filter-label"><SlidersHorizontal size={15} /> Role</div>
      <div className="filter-pills" role="group" aria-label="Filter players by role">{roles.map((item) => <button type="button" key={item} className={`filter-pill ${role === item ? 'selected' : ''}`} onClick={() => setRole(item)}>{item}</button>)}</div>
      <span className="results-count">{visibleCount} players</span>
    </section>
    <section className="player-empty-layout">
      <div className="player-empty-main"><PlayerCard title="Player profiles are on the way" subtitle={query ? `No profiles match “${query}” yet. Player data has not been connected.` : 'Player names, roles, photos and verified performance records will appear here when the league feed is connected.'} icon="batter" /><span className="empty-footnote">Role filter: {role} · No player results are being simulated.</span></div>
      <aside className="player-leaderboard"><span className="section-eyebrow">PERFORMANCE BOARD</span><h2>Season leaders</h2><p>Player statistics will be shown here with source-backed figures.</p><div className="leaderboard-line"><span><b>RUNS</b> Most runs</span><strong>—</strong></div><div className="leaderboard-line"><span><b>WICKETS</b> Most wickets</span><strong>—</strong></div><div className="leaderboard-line"><span><b>STRIKE RATE</b> Batting impact</span><strong>—</strong></div><div className="leaderboard-line"><span><b>ECONOMY</b> Bowling control</span><strong>—</strong></div></aside>
    </section>
  </div>
}
