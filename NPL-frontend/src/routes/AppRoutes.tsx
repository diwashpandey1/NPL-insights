import { Navigate, Route, Routes } from 'react-router-dom'
import { DashboardLayout } from '../layouts/DashboardLayout'
import { DashboardPage } from '../pages/Dashboard/DashboardPage'
import { PlayersPage } from '../pages/Players/PlayersPage'
import { TeamsPage } from '../pages/Teams/TeamsPage'
import { MatchesPage } from '../pages/Matches/MatchesPage'
import { StandingsPage } from '../pages/Standings/StandingsPage'
import { HeadToHeadPage } from '../pages/HeadToHead/HeadToHeadPage'

export function AppRoutes() {
  return <Routes><Route element={<DashboardLayout />}><Route index element={<DashboardPage />} /><Route path="players" element={<PlayersPage />} /><Route path="teams" element={<TeamsPage />} /><Route path="matches" element={<MatchesPage />} /><Route path="standings" element={<StandingsPage />} /><Route path="head-to-head" element={<HeadToHeadPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes>
}
