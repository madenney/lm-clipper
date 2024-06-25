import { useState, Dispatch, SetStateAction } from 'react'
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
import '../styles/Main.css'

type MainProps = {
  archive: ShallowArchiveInterface
  setArchive: Dispatch<
    SetStateAction<ShallowArchiveInterface | null | undefined>
  >
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface>>
}

export default function Main({
  archive,
  setArchive,
  config,
  setConfig,
}: MainProps) {
  const [isResultsOpen, setResultsOpen] = useState(false)
  const [selectedFilter, setSelectedFilter] =
    useState<ShallowFilterInterface | null>(null)
  return (
    <div className="page">
      <Navbar archive={archive} config={config} setConfig={setConfig}/>
      <div className="main-content">
        <Replays archive={archive} setArchive={setArchive} />
        <Filters
          archive={archive}
          setArchive={setArchive}
          setResultsOpen={setResultsOpen}
          setSelectedFilter={setSelectedFilter}
        />
        
        {/* TODO: Make this available in dev mode
        
        <Results
          archive={archive}
          isResultsOpen={isResultsOpen}
          setResultsOpen={setResultsOpen}
          selectedFilter={selectedFilter}
        /> */}
        <Video archive={archive} config={config} setConfig={setConfig} />
      </div>
    </div>
  )
}
