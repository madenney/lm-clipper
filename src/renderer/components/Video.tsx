/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState } from 'react'
import '../styles/Filters.css'
import { ShallowArchiveInterface } from '../../constants/types'

type VideoProps = {
  archive: ShallowArchiveInterface
}

export default function Video({ archive }: VideoProps) {

  const [isVideoOpen, setVideoOpen] = useState(false)

  return (
    <div className="section">
      <div className="title" onClick={() => setVideoOpen(!isVideoOpen)}>
        Video<span>{isVideoOpen ? '▼' : '▲'}</span>
      </div>
      {isVideoOpen ? <div className="section-content">VIDEO</div> : ''}
    </div>
  )
}
