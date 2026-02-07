import { createRoot } from 'react-dom/client'
import App from './App'

const preventDragDefault = (event: DragEvent) => {
  event.preventDefault()
}

const dragEvents: Array<keyof WindowEventMap> = ['dragenter', 'dragover', 'drop']
const dragListenerOptions: AddEventListenerOptions = { capture: true }
dragEvents.forEach((eventName) => {
  document.addEventListener(eventName, preventDragDefault, dragListenerOptions)
  window.addEventListener(eventName, preventDragDefault, dragListenerOptions)
})

const container = document.getElementById('root')!
const root = createRoot(container)
root.render(<App />)
