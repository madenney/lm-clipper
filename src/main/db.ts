
import { spawn } from 'child_process'
import fs from 'fs'
import { getSqlitePath } from './util'
import { asyncForEach } from '../lib'
const sqlite3Path = getSqlitePath()
import {
  archive as defaultArchive,
} from '../constants/defaults'
import { FileInterface } from 'constants/types'


export async function dbExists(path: string){
  try {
    await runSqliteCommand([path, '.tables'])
    return true
  } catch(e){
    return false
  }
}

export async function createDB(path: string, name: string){

  console.log("Creating DB")
  // create db
  await runSqliteCommand([path, '.quit'])

  // create metadata table
  const createMetadataTableSQL = `CREATE TABLE IF NOT EXISTS metadata (JSON TEXT);`
  await runSqliteCommand([path, createMetadataTableSQL])

  // Insert new metadata

  const metadata = { 
    ...defaultArchive, 
    path, 
    name,
    createdAt: Date.now(),
   }

  const newMetadataSQL = `INSERT INTO metadata (JSON) 
    VALUES ('${JSON.stringify(metadata)}');`
  await runSqliteCommand([path, newMetadataSQL])
  
  // create files table
  const createFilesTableSQL = `
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT,
    players TEXT,
    winner INTEGER,
    startedAt INTEGER,
    lastFrame INTEGER,
    isValid INTEGER,
    isProcessed INTEGER,
    info TEXT
  );`
  await runSqliteCommand([path, createFilesTableSQL])

  // create filter results list
  await asyncForEach(metadata.filters, async filter => {
    const sql = `
    CREATE TABLE IF NOT EXISTS ${filter.id} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fileID INTEGER,
      filePath TEXT,
      startFrame INTEGER,
      endFrame INTEGER
    );`
    await runSqliteCommand([path, sql])
  })
}




export async function getMetaData(path: string){
  console.log("\ngetMetaData")
  try {

    // get column names
    const sqlResponse = await runSqliteCommand([path, `SELECT * FROM metadata`])
    const metadata = JSON.parse(sqlResponse[0][0])
    
    // get # files
    const totalFilesSQL = `SELECT COUNT(*) AS count FROM files;`;
    const validFilesSQL = `SELECT COUNT(*) AS count FROM files WHERE isValid = 1;`;

    const total = await runSqliteCommand([path, totalFilesSQL])
    const valid = await runSqliteCommand([path, validFilesSQL])

    metadata.totalFiles = parseInt(total[0][0])
    metadata.validFiles = parseInt(valid[0][0])


    // get each filter's results count
    await asyncForEach(metadata.filters, async filter => {
      const totalFilesSQL = `SELECT COUNT(*) AS count FROM ${filter.id};`;
      const total = await runSqliteCommand([path, totalFilesSQL])
      filter.results = total[0][0]
      // const currentFilter = metadata.filters.find(f => f.id == filter.id)
      // currentFilter.results = parseInt(total[0][0])
    })
    
    return metadata

  } catch(e) {
    console.log("Error Fetching Metadata :(")
    console.log(e)
    return false
  }
}


export async function getFileByPath(path: string, filePath: string){

  const sql = `SELECT * FROM files WHERE path = '${filePath}' LIMIT 1;`
  const response = await runSqliteCommand([path, sql])
  console.log("RESPONSE: ", response)
  return response[0][0]
}

export async function insertFile(path: string, fileJSON: FileInterface){

  const sql =`INSERT INTO files (
    path,
    players,
    winner,
    startedAt,
    lastFrame,
    isValid,
    isProcessed,
    info
  ) VALUES (
    '${fileJSON.path.replace(/\|/g, '')}',             
    '${JSON.stringify(fileJSON.players).replace(/\|/g, '')}',             
    ${fileJSON.winner},                               
    ${fileJSON.startedAt ? fileJSON.startedAt : 0},                     
    ${fileJSON.lastFrame},                            
    ${fileJSON.isValid ? 1 : 0},                               
    ${fileJSON.isProcessed ? 1 : 0},                               
    '${fileJSON.info}'
  );`

  const response = await runSqliteCommand([path, sql])
  console.log("RESPONSE: ", response)
}

export async function getValidFiles(path: string){
  const sql = 'SELECT * FROM files WHERE isValid = 1'
  const response = await runSqliteCommand([path, sql])
  return response
}

export function startDB(){

}

export function createTable(){

}

export function deleteTable(){

}

export function iterateThroughRows(){

}

export function testDB(){


  //const sqlite3Path = getSqlitePath()

  // // Create a new table and insert data
  // runSqliteCommand([dbFile, 'CREATE TABLE lorem (info TEXT);'], () => {
  //   runSqliteCommand([dbFile, "INSERT INTO lorem VALUES ('Hello, world!');"], () => {
  //     runSqliteCommand([dbFile, "INSERT INTO lorem VALUES ('Ringo, Dinog!');"], () => {
  //     runSqliteCommand([dbFile, 'SELECT * FROM lorem;']);
  //   });
  //   });
  // });
}


function runSqliteCommand(args: string[]) {
  console.log("\nRunning SQL Command: ", args.join(" "))
  return new Promise<any>((resolve, reject) => {
    const sqlite = spawn(sqlite3Path, args);
    let output = ""
    sqlite.stdout.on('data', (data) => {
      //console.log(`stdout: ${data}`);
      output += data.toString()
    });
    sqlite.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
      reject()
    });

    sqlite.on('close', (code) => {
      if(code == 0){
        console.log("Successfully ran SQL command\n")
        const rows = output.trim().split('\n').map(row => row.split('|'));
        return resolve(rows)
      } else {
        console.log("Error running SQL command\n")
        return reject()
      }
    });
  })

}

