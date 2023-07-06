import { lstatSync, readdirSync } from 'fs'
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
