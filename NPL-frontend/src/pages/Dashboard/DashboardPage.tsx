import { motion } from 'framer-motion'
import { ArrowRight, ChevronRight, Radio, Trophy } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CricketStat } from '../../components/sports/CricketStat'
import { MatchCard } from '../../components/sports/MatchCard'
import { PlayerCard } from '../../components/sports/PlayerCard'
import { PointsTable } from '../../components/sports/PointsTable'
import { TeamLogo } from '../../components/ui/TeamLogo'
import { teams } from '../../constants/teams'

export function DashboardPage() {
  return <div className="page-stack">
    <section className="league-hero">
      <div className="league-hero-copy">
        <span className="season-kicker"><Trophy size={14} /> Nepal Premier League · Season III</span>
        <h1>Cricket, through<br /><em>a Nepal lens.</em></h1>
        <p>A focused home for league standings, match stories and the numbers behind every over.</p>
        <div className="hero-actions"><Link className="button button-crimson" to="/matches">Go to match centre <ArrowRight size={16} /></Link></div>
      </div>
      <div className="league-hero-art" aria-label="Official Nepal Premier League branding">
        <div className="hero-art-top"><span><Radio size={13} /> NPL ANALYTICS</span><span>2026</span></div>
        <img src="/assets/branding/npl-logo.png" alt="Nepal Premier League official logo" />
        <div className="hero-art-bottom"><span>Competition data</span><b>Awaiting verified feed</b></div>
        <span className="hero-ball-mark" aria-hidden="true" />
      </div>
    </section>

    <section className="league-pulse" aria-label="League statistic placeholders">
      <div className="pulse-intro"><span>LEAGUE PULSE</span><strong>Numbers that<br />shape the season.</strong></div>
      <CricketStat icon="matches" label="Matches" value="—" note="feed pending" />
      <CricketStat icon="batter" label="Players" value="—" note="feed pending" />
      <CricketStat icon="runs" label="Runs scored" value="—" note="feed pending" />
      <CricketStat icon="wickets" label="Wickets" value="—" note="feed pending" />
    </section>

    <div className="home-grid">
      <section className="content-panel home-standings">
        <div className="panel-title-row"><div><span className="section-eyebrow">THE LEAGUE</span><h2>Points table</h2><p>Season III standings, once connected.</p></div><Link className="quiet-link" to="/standings">Full table <ChevronRight size={16} /></Link></div>
        <PointsTable preview />
      </section>
      <section className="content-panel home-match">
        <div className="panel-title-row"><div><span className="section-eyebrow">MATCHDAY</span><h2>Featured fixture</h2><p>Fixture details appear when the official feed is available.</p></div><Link className="quiet-link" to="/matches">Match centre <ChevronRight size={16} /></Link></div>
        <MatchCard featured />
        <div className="feed-note"><span className="feed-note-pulse" /> Official match and venue data has not been connected.</div>
      </section>
    </div>

    <section className="schedule-section dashboard-recent">
      <div className="panel-title-row"><div><span className="section-eyebrow">LATEST RESULTS</span><h2>Recent matches</h2><p>Results are shown only after verified match records are available.</p></div><Link className="quiet-link" to="/matches">All matches <ChevronRight size={16} /></Link></div>
      <div className="schedule-empty compact-empty"><span className="schedule-calendar"><Radio size={20} /></span><strong>No recent results loaded</strong><p>The official match feed has not supplied any completed fixtures yet.</p></div>
    </section>

    <section className="teams-ribbon">
      <div className="ribbon-title"><div><span className="section-eyebrow">EIGHT FRANCHISES</span><h2>Meet the league</h2></div><Link className="quiet-link" to="/teams">All teams <ChevronRight size={16} /></Link></div>
      <div className="team-ribbon-list">{teams.map((team) => <Link className="team-ribbon-item" to="/teams" key={team.id}><TeamLogo team={team} size="medium" /><span>{team.name}</span></Link>)}</div>
    </section>

    <section className="performers-section">
      <div className="ribbon-title"><div><span className="section-eyebrow">PLAYER WATCH</span><h2>Performances to follow</h2></div><Link className="quiet-link" to="/players">Player index <ChevronRight size={16} /></Link></div>
      <div className="performer-grid"><PlayerCard title="Batting leaders" subtitle="Runs, boundaries and strike rates will appear when player data is connected." icon="batter" /><PlayerCard title="Bowling leaders" subtitle="Wickets, overs and economy figures will appear when player data is connected." icon="bowler" /><motion.div className="insight-cta" whileHover={{ y: -3 }}><span className="insight-icon"><Trophy size={19} /></span><span className="section-eyebrow">NPL INSIGHTS</span><h3>Find the story in every spell.</h3><p>Verified season metrics will power player and team insights here.</p><Link className="text-arrow" to="/head-to-head">Explore comparisons <ArrowRight size={15} /></Link></motion.div></div>
    </section>
  </div>
}
