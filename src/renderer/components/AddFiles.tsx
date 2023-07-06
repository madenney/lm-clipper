/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import '../styles/AddFiles.css'
import { ShallowArchiveInterface } from '../../constants/types'

type Props = {
  archive: ShallowArchiveInterface
}

export default function AddFiles({ archive }: Props) {
  function handleClick() {
    console.log('click')
    console.log(archive)
  }

  return (
    <div className="addFiles">
      <div onClick={handleClick} className="importFilesButton">
        Import Slippi Files
      </div>
    </div>
  )
}
