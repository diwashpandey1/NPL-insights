import { BrowserRouter } from 'react-router-dom'
import { ToastContainer } from 'react-toastify'
import { AppRoutes } from './routes/AppRoutes'
import 'react-toastify/dist/ReactToastify.css'
import './App.css'

function App() {
  return <BrowserRouter><AppRoutes /><ToastContainer position="bottom-right" theme="dark" /></BrowserRouter>
}
export default App
