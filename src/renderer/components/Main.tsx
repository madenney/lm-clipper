// import fs from 'fs'
// import Header from "./Header"
// import Files from "./Files"
// import Patterns from "./Patterns"
// import { Archive } from '../models/Archive'
// import NoArchive from './NoArchive'
import { useState, Dispatch, SetStateAction } from 'react'
import {
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'
import Navbar from './Navbar'
import Filters from './Filters'
import Results from './Results'
import Video from './Video'
import '../styles/Main.css'

type MainProps = {
  archive: ShallowArchiveInterface
  setArchive: Dispatch<
    SetStateAction<ShallowArchiveInterface | null | undefined>
  >
}

export default function Main({ archive, setArchive }: MainProps) {
  const [isResultsOpen, setResultsOpen] = useState(false)
  const [selectedFilter, setSelectedFilter] =
    useState<ShallowFilterInterface | null>(null)
  return (
    <div className="page">
      <Navbar archive={archive} />
      {archive.files === 0 ? (
        <div className="noFilesMessageContainer">
          <div className="noFilesMessage">
            Import Slippi Replays by dropping them anywhere in this window
          </div>
          <div className="orClickHere">
            {'(or click File -> Import Slippi Replays)'}
          </div>
        </div>
      ) : (
        <div className="main-content">
          <Filters
            archive={archive}
            setArchive={setArchive}
            setResultsOpen={setResultsOpen}
            setSelectedFilter={setSelectedFilter}
          />
          <Results
            archive={archive}
            isResultsOpen={isResultsOpen}
            setResultsOpen={setResultsOpen}
            selectedFilter={selectedFilter}
          />
          <Video archive={archive} />
        </div>
      )}
    </div>
  )
}

// class App extends React.Component {

// 	constructor(props){
// 		super(props)
// 		this.state = {
// 			archive: null
// 		}
// 	  }

// 	componentDidMount(){
// 		if(localStorage.last_archive && fs.existsSync(localStorage.last_archive)){
// 			this.setState({
// 				archive: new Archive(localStorage.last_archive)
// 			})
// 		}
// 	}

// 	closeArchive() {
// 		this.setState({ archive: null })
// 	}

// 	render(){
// 		const { archive } = this.state
// 		console.log("render-archive:", archive)
// 		if(archive){
// 			return (
// 				<div className='main-content'>
// 					<Header archive={archive} closeArchive={this.closeArchive.bind(this)}/>
// 					<Files archive={archive}/>
// 					<Patterns archive={archive}/>
// 				</div>
// 			)
// 		} else {
// 			return <NoArchive setArchive={(archive) => this.setState({archive})}/>
// 		}
// 	}
// }
