import { createRoot } from 'react-dom/client'
import CodeEditorPage from './components/CodeEditorPage'

const container = document.getElementById('root')!
const root = createRoot(container)
root.render(<CodeEditorPage />)
