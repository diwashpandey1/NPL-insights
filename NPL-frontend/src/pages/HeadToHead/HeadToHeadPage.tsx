import { useMemo, useState } from 'react'
import { ArrowDownUp, Swords } from 'lucide-react'
import { CricketStat } from '../../components/sports/CricketStat'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { TeamLogo } from '../../components/ui/TeamLogo'
import { teams } from '../../constants/teams'

export function HeadToHeadPage() {
  const [teamAId, setTeamAId] = useState(teams[0]!.id)
  const [teamBId, setTeamBId] = useState(teams[1]!.id)
  const teamA = useMemo(() => teams.find((team) => team.id === teamAId) ?? teams[0]!, [teamAId])
  const teamB = useMemo(() => teams.find((team) => team.id === teamBId) ?? teams[1]!, [teamBId])
  const swapTeams = () => { setTeamAId(teamBId); setTeamBId(teamAId) }
  return <div className="page-stack">
    <SectionHeader eyebrow="TEAM COMPARISON · NPL" title="Head to head." description="Compare two franchises across their NPL meetings, results and scoring records." />
    <section className="comparison-picker">
      <div className="comparison-team-select"><TeamLogo team={teamA} size="large" /><label>TEAM A<select value={teamAId} onChange={(event) => setTeamAId(event.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label></div>
      <button className="swap-button" type="button" onClick={swapTeams} aria-label="Swap teams"><ArrowDownUp size={18} /></button>
      <div className="comparison-versus">VS</div>
      <div className="comparison-team-select"><TeamLogo team={teamB} size="large" /><label>TEAM B<select value={teamBId} onChange={(event) => setTeamBId(event.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label></div>
    </section>
    <section className="comparison-scoreboard">
      <div className="comparison-heading"><Swords size={18} /><div><strong>{teamA.name}</strong><span>against</span><strong>{teamB.name}</strong></div><small>ALL NPL SEASONS</small></div>
      <div className="comparison-metrics"><CricketStat icon="matches" label="Meetings" value="—" note="data pending" /><CricketStat icon="win" label={`${teamA.shortName} wins`} value="—" /><CricketStat icon="win" label={`${teamB.shortName} wins`} value="—" /><CricketStat icon="loss" label="No result" value="—" /></div>
      <div className="comparison-bars"><div className="comparison-bar-row"><span>{teamA.shortName}</span><div><i /></div><span>—</span></div><div className="comparison-bar-row"><span>{teamB.shortName}</span><div><i /></div><span>—</span></div></div>
      <p className="comparison-footnote">Historical results and scoring comparisons will populate once verified match records are connected.</p>
    </section>
    <section className="schedule-section"><div className="panel-title-row"><div><span className="section-eyebrow">MEETING HISTORY</span><h2>Past encounters</h2></div></div><div className="schedule-empty compact-empty"><span className="schedule-calendar"><Swords size={20} /></span><strong>No head-to-head records loaded</strong><p>Select two teams above. Their match history will appear here when connected.</p></div></section>
  </div>
}
