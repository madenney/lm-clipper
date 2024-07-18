import { useState, Dispatch, SetStateAction, useEffect } from 'react'
import {
  ConfigInterface,
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'
import Navbar from './Navbar'
import Replays from './Replays'
import Filters from './Filters'
import Results from './Results'
import Video from './Video'
import Tray from './Tray'
import ipcBridge from 'renderer/ipcBridge'
import '../styles/Main.css'

type MainProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<
    SetStateAction<ShallowArchiveInterface | null >
  >
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Main({
  archive,
  setArchive,
  config,
  setConfig,
}: MainProps) {
  // const [isResultsOpen, setResultsOpen] = useState(false)
  // const [selectedFilter, setSelectedFilter] =
  //   useState<ShallowFilterInterface | null>(null)
  const [leftWidth, setLeftWidth] = useState(300);
  const [areListenersDefined, setAreListenersDefined] = useState(false)
  const [dragover, setDragover] = useState(false)
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!areListenersDefined) {

      document.addEventListener('drop', async (event) => {
        event.preventDefault()
        event.stopPropagation()

        if (event.dataTransfer) {
          const newArchive = await ipcBridge.importDroppedSlpFiles(
            Array.from(event.dataTransfer?.files).map((file) => file.path)
          )
          setArchive(newArchive)
        }
      })
      document.addEventListener('dragover', (e) => {
        e.preventDefault()
        setDragover(true)
      })
      console.log('Added event listeners')
      setAreListenersDefined(true)
    }
  }, [areListenersDefined])


  // really don't need this but it's cool
  // tracks mouse position for dragover radial gradient effect
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      setMousePosition({
        x: event.clientX,
        y: event.clientY,
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('dragover', handleMouseMove);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('dragover', handleMouseMove);
    };
  }, []);

  const startResizing = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    e.preventDefault(); // Prevent default behavior
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResizing);
  };

  const resize = (e: MouseEvent ) => {
    e.preventDefault()
    const newLeftWidth = e.clientX ;
    if (newLeftWidth > 100 && newLeftWidth < window.innerWidth - 100) { 
      setLeftWidth(newLeftWidth);
    }
  };

  const stopResizing = () => {
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResizing);
  };

  

  return (
    <div className="main" onDragEnter={() => setDragover(true)}>
      { dragover ? (
        <div 
          className="dragover"
          style={{backgroundImage: `radial-gradient(at ${mousePosition.x}px ${mousePosition.y}px,#262525,#1c1b1b,#080808)`}}
          onDragLeave={() => setDragover(false)}
        ></div> 
      ) : ""}
      <div className="top"></div>
      <div className="trayContainer">
        <div className="sidebar" style={{ width: `${leftWidth}px`}}></div>
        <div className="divider" onMouseDown={startResizing}></div>
        <Tray archive={archive} ></Tray>
      </div>
      <div className="footer"></div>
      {/*<Navbar archive={archive} config={config} setConfig={setConfig}/>*/}
      {/*<div className="main-content">*/}
        {/*<Replays archive={archive} setArchive={setArchive} />*/}
        {/*<Filters
          archive={archive}
          setArchive={setArchive}
          setResultsOpen={setResultsOpen}
          setSelectedFilter={setSelectedFilter}
        />*/}
        
        {/* TODO: Make this available in dev mode
        
        <Results
          archive={archive}
          isResultsOpen={isResultsOpen}
          setResultsOpen={setResultsOpen}
          selectedFilter={selectedFilter}
        /> */}
        {/*<Video archive={archive} config={config} setConfig={setConfig} />*/}
      {/*</div>*/}
    </div>
  )
}
