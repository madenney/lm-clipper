import { useState, Dispatch, SetStateAction, useEffect } from 'react'
import {
  ConfigInterface,
  ShallowArchiveInterface,
} from '../../constants/types'
import Top from './Top'
import Filters from './Filters'
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
  const [leftWidth, setLeftWidth] = useState(580);
  const [areListenersDefined, setAreListenersDefined] = useState(false)
  const [dragover, setDragover] = useState(false)
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!areListenersDefined) {

      document.addEventListener('drop', async (event) => {
        event.preventDefault()
        event.stopPropagation()

        if (event.dataTransfer && event.dataTransfer.files.length > 0) {

          // this must occur before async functions because... something html, idk
          const filePaths = Array.from(event.dataTransfer.files).map((file) => file.path)
          
          // check if archive exists, create new default one if it doesn't
          const archive = await ipcBridge.getArchive()
          if(!archive){
            await ipcBridge.createNewArchive({})
          }

          const response = await ipcBridge.addDroppedFiles( filePaths )
          if(!response){ console.log("Error dropping files") }
          setArchive( await ipcBridge.getArchive() )
        }
      })

      document.addEventListener('dragover', (e) => {
        e.preventDefault()
        setDragover(true)
      })
      
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
          onDrop={() => setDragover(false)}
        ></div> 
      ) : ""}
      
      <Top archive={archive} config={config} setConfig={setConfig}/>
      <div className="mid">
        <div className="sidebar" style={{ width: `${leftWidth}px`}}>
          <Filters archive={archive} setArchive={setArchive}/>
        </div>
        <div className="divider" onMouseDown={startResizing}></div>
        <Tray archive={archive} setArchive={setArchive}/>
      </div>
      <div className="footer"></div>
    </div>
  )
}
