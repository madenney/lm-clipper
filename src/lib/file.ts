import { lstatSync, readdirSync, promises as fsPromises } from 'fs'
// import { /* , statSync, mkdirSync*/ } from 'fs'
import path from 'path'
// import rimraf from 'rimraf'

/*
	- Takes an array of file/directory paths and returns all .slp file paths located within
*/
export const getSlpFilePaths = (_paths: string | string[]) => {
  const paths = Array.isArray(_paths) ? _paths : [_paths]
  let filePaths: string[] = []
  paths.forEach((p) => {
    const fileInfo = lstatSync(p)
    if (fileInfo.isDirectory()) {
      readdirSync(p).forEach((p1) => {
        filePaths = filePaths.concat(getSlpFilePaths(path.resolve(p, p1)))
      })
    }
    if (fileInfo.isFile() && path.extname(p) === '.slp') {
      filePaths.push(p)
    }
  })
  return filePaths
}

/*
	- Takes an array of file/directory paths and returns all .slp file paths located within
*/
export const getImgFilePaths = (_paths: string | string[]) => {
  const paths = Array.isArray(_paths) ? _paths : [_paths]
  let filePaths: string[] = []
  paths.forEach((p) => {
    const fileInfo = lstatSync(p)
    if (fileInfo.isDirectory()) {
      readdirSync(p).forEach((p1) => {
        filePaths = filePaths.concat(getSlpFilePaths(path.resolve(p, p1)))
      })
    }
    if (fileInfo.isFile() && path.extname(p) === '.png') {
      filePaths.push(p)
    }
  })
  return filePaths
}

type StreamOptions = {
  signal?: AbortSignal
}

const normalizeExtensions = (extensions: string[]) =>
  new Set(extensions.map((ext) => ext.toLowerCase()))

async function* streamFilePathsByExtension(
  _paths: string | string[],
  extensions: string[],
  options: StreamOptions = {}
) {
  const paths = Array.isArray(_paths) ? _paths : [_paths]
  const extSet = normalizeExtensions(extensions)
  const stack = [...paths]

  while (stack.length > 0) {
    if (options.signal?.aborted) return
    const currentPath = stack.pop()
    if (!currentPath) continue

    let stats
    try {
      stats = await fsPromises.lstat(currentPath)
    } catch (error) {
      continue
    }

    if (stats.isDirectory()) {
      let dir
      try {
        dir = await fsPromises.opendir(currentPath)
      } catch (error) {
        continue
      }

      let aborted = false
      try {
        for await (const entry of dir) {
          if (options.signal?.aborted) {
            aborted = true
            break
          }

          const nextPath = path.resolve(currentPath, entry.name)
          if (entry.isDirectory()) {
            stack.push(nextPath)
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (extSet.has(ext)) yield nextPath
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (options.signal?.aborted && code === 'ERR_DIR_CLOSED') return
        throw error
      }
      if (aborted || options.signal?.aborted) return
      continue
    }

    if (stats.isFile()) {
      const ext = path.extname(currentPath).toLowerCase()
      if (extSet.has(ext)) yield currentPath
    }
  }
}

export async function* streamSlpFilePaths(
  _paths: string | string[],
  options: StreamOptions = {}
) {
  yield* streamFilePathsByExtension(_paths, ['.slp'], options)
}

// export const isDirectory = source => lstatSync( source ).isDirectory()

// const getDirectories = source => {
// 	return readdirSync( path.resolve(source) ).map( name => {
// 		return path.resolve( path.join( source, name) )
// 	}).filter(isDirectory)
// }

// const getFiles = ( source, recursive = false ) => {
// 	if( !recursive ) {
// 		return readdirSync( source )
// 	} else {
// 		return walkSync( source, [] )
// 	}

// }

// const walkSync = function(dir, filelist) {
// 	files = readdirSync(dir);
// 	files.forEach(function(file) {
// 		if ( statSync(dir + '/' + file).isDirectory() ) {
// 			filelist = walkSync(dir + '/' + file, filelist);
// 		}
// 		else {
// 			filelist.push({
// 				name: file,
// 				path: path.resolve( dir + "/" + file )
// 			});
// 		}
// 	});
// 	return filelist;
// }

// const createDir = async function( dirPath ){
//     await new Promise( ( resolve, reject ) => rimraf( dirPath, () => {
//     	try {
// 			mkdirSync( dirPath )
//     	} catch ( error ){
//     		console.log("Error occurred while trying to mkdir: " + dirPath)
//     		return reject()
//     	}
// 	   	resolve()
//     }))
// }
