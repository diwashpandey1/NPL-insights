import { SectionHeader } from '../../components/ui/SectionHeader'
import { TeamCard } from '../../components/sports/TeamCard'
import { teams } from '../../constants/teams'

export function TeamsPage() {
  return <div className="page-stack">
    <SectionHeader eyebrow="FRANCHISE DIRECTORY · SEASON III" title="Eight teams. One league." description="Explore the NPL franchises and their official marks. Team performance will populate when verified statistics are available." />
    <div className="directory-note"><span className="directory-note-mark">NPL</span><span>Franchise identities are shown with their sourced team logos. Season records are not connected.</span></div>
    <section className="team-directory-grid" aria-label="NPL teams">{teams.map((team) => <TeamCard team={team} key={team.id} />)}</section>
  </div>
}
