import { CalendarDays, MapPin, Radio } from 'lucide-react'
import { CricketIcon } from '../ui/CricketIcon'

export function MatchCard({ featured = false }: { featured?: boolean }) {
  return <article className={`match-card ${featured ? 'match-card--featured' : ''}`}>
    <div className="match-card-head"><span className="match-live-label"><Radio size={13} /> MATCH CENTRE</span><span className="match-state">FIXTURE FEED PENDING</span></div>
    <div className="match-card-main">
      <div className="match-side"><span className="team-crest-placeholder"><CricketIcon name="matches" size={24} /></span><span>HOME</span><strong>Team to be confirmed</strong></div>
      <div className="match-versus"><CricketIcon name="matches" size={28} /><span>VS</span><i /></div>
      <div className="match-side"><span className="team-crest-placeholder"><CricketIcon name="matches" size={24} /></span><span>AWAY</span><strong>Team to be confirmed</strong></div>
    </div>
    <div className="match-card-footer"><span><CalendarDays size={14} /> Date pending</span><span><MapPin size={14} /> Venue pending</span></div>
  </article>
}
