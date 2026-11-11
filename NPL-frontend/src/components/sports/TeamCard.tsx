import { ArrowUpRight } from 'lucide-react'
import type { Team } from '../../constants/teams'
import { TeamLogo } from '../ui/TeamLogo'

export function TeamCard({ team }: { team: Team }) {
  return <article className="team-card">
    <span className="team-card-index">NPL FRANCHISE</span>
    <TeamLogo team={team} size="large" />
    <h2>{team.name}</h2>
    <div className="team-card-meta"><span>Season III · 2026</span><b>—</b></div>
    <div className="team-card-meta"><span>Team statistics</span><b>Awaiting data</b></div>
    <span className="team-card-foot">Profile details not connected <ArrowUpRight size={14} /></span>
  </article>
}
