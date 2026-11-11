import { useState } from 'react'
import { CalendarDays, ListFilter } from 'lucide-react'
import { MatchCard } from '../../components/sports/MatchCard'
import { SectionHeader } from '../../components/ui/SectionHeader'

const tabs = ['All matches', 'Upcoming', 'Results']

export function MatchesPage() {
  const [activeTab, setActiveTab] = useState(tabs[0]!)
  return <div className="page-stack">
    <SectionHeader eyebrow="NPL MATCH CENTRE · SEASON III" title="Every match has a story." description="Follow fixtures, results and venues from the Nepal Premier League season." />
    <div className="match-toolbar"><div className="match-tabs" role="tablist" aria-label="Match status">{tabs.map((tab) => <button role="tab" aria-selected={activeTab === tab} type="button" className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}</div><span className="match-filter-note"><ListFilter size={15} /> {activeTab} · season feed pending</span></div>
    <section className="match-feature-grid"><div className="match-feature-copy"><span className="section-eyebrow"><CalendarDays size={14} /> MATCHDAY BOARD</span><h2>The next ball<br />starts here.</h2><p>Match dates, venues and scorecards will appear when the official fixture feed is available.</p><span className="feed-status"><i /> No fixtures loaded</span></div><MatchCard featured /></section>
    <section className="schedule-section"><div className="panel-title-row"><div><span className="section-eyebrow">FIXTURE LIST</span><h2>{activeTab}</h2><p>Schedule details are intentionally blank until match data is connected.</p></div></div><div className="schedule-empty"><span className="schedule-calendar"><CalendarDays size={22} /></span><strong>No match data available</strong><p>When the NPL match schedule is connected, fixtures, results, dates and venues will be listed here.</p></div></section>
  </div>
}
