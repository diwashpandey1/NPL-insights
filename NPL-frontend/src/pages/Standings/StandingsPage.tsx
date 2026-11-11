import { CricketIcon } from '../../components/ui/CricketIcon'
import { PointsTable } from '../../components/sports/PointsTable'
import { SectionHeader } from '../../components/ui/SectionHeader'

export function StandingsPage() {
  return <div className="page-stack">
    <SectionHeader eyebrow="LEAGUE TABLE · SEASON III" title="The race for the top." description="A full NPL standings view with run rate and match record. Official table data is not connected yet." />
    <section className="standings-banner"><span className="standings-banner-icon"><CricketIcon name="points" size={27} /></span><div><span>SEASON III · 2026</span><strong>Standings update when results are verified.</strong></div><span className="standings-status">TABLE PENDING</span></section>
    <section className="content-panel standings-panel"><div className="panel-title-row"><div><span className="section-eyebrow">ALL FRANCHISES</span><h2>NPL points table</h2><p>Played, won, lost, no result, net run rate and points.</p></div></div><PointsTable /></section>
    <p className="table-mobile-hint">Swipe horizontally to see every table column on a small screen.</p>
  </div>
}
