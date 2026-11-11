import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { teams } from '../../constants/teams'
import { TeamLogo } from '../ui/TeamLogo'

const columns = ['P', 'W', 'L', 'NR', 'NRR', 'PTS']

export function PointsTable({ preview = false }: { preview?: boolean }) {
  const visibleTeams = preview ? teams.slice(0, 4) : teams
  return <div className="points-table-shell">
    <div className="table-note"><span className="table-note-dot" /> Standings feed is not connected. Values are intentionally blank.</div>
    <div className="table-scroll"><table className="league-table">
      <thead><tr><th scope="col">#</th><th scope="col">TEAM</th>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{visibleTeams.map((team) => <tr key={team.id}><td className="table-rank">—</td><td><span className="table-team"><TeamLogo team={team} size="small" /><strong>{team.name}</strong></span></td>{columns.map((column) => <td className="table-number" key={column}>—</td>)}</tr>)}</tbody>
    </table></div>
    {preview && <Link className="table-more" to="/standings">Open full points table <ArrowRight size={15} /></Link>}
  </div>
}
