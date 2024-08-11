
import { spawn } from 'child_process'
import { getSqlitePath } from '../main/util'
import { asyncForEach } from '../lib'
const sqlite3Path = getSqlitePath()

import { FileInterface, FilterInterface, ArchiveInterface } from 'constants/types'


export async function dbExists(path: string){
  try {
    await runSqliteCommand([path, '.tables'], 1)
    return true
  } catch(e){
    return false
  }
}

export async function createDB(path: string, metadata: ArchiveInterface){

    // create db
    await runSqliteCommand([path, '.quit'])
  
    // create metadata table
    const createMetadataTableSQL = `CREATE TABLE IF NOT EXISTS metadata (JSON TEXT);`
    await runSqliteCommand([path, createMetadataTableSQL])
  
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
      stage INTEGER,
      startedAt INTEGER,
      lastFrame INTEGER,
      isProcessed INTEGER,
      info TEXT
    );`
    await runSqliteCommand([path, createFilesTableSQL])
  
    // create filter results list
    await asyncForEach(metadata.filters, async filter => {
      const sql = `
      CREATE TABLE IF NOT EXISTS ${filter.id} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        JSON TEXT
      );`
      await runSqliteCommand([path, sql])
    })
}

export async function getMetaData(path: string){
    console.log("\nDB - Getting Meta Data")
    try {
  
      // get column names
      const sqlResponse = await runSqliteCommand([path, `SELECT * FROM metadata`])
      const metadata = JSON.parse(sqlResponse[0][0])
      
      // get # files
      const totalFilesSQL = `SELECT COUNT(*) AS count FROM files;`;
  
      const total = await runSqliteCommand([path, totalFilesSQL])
  
      metadata.files = parseInt(total[0][0])
  
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
      console.log("DB Error while fetching metadata")
      console.log(e)
    }
}

export async function updateMetaData(path: string, newMetaData: string){
    const sql = `
    UPDATE metadata
    SET JSON = '${newMetaData}';`
    await runSqliteCommand([path, sql])
}

export async function createFilterTable(path: string, id: string){
    const sql = `
    CREATE TABLE IF NOT EXISTS ${id} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      JSON TEXT
    );`
    await runSqliteCommand([path, sql])
}

export async function deleteFilterTable(path: string, id: string){
    const sql = `
    DROP TABLE IF EXISTS ${id};`
    await runSqliteCommand([path, sql])
}

export async function getFileByPath(path: string, filePath: string){
    const sql = `SELECT * FROM files WHERE path = '${escapeSqlString(filePath)}' LIMIT 1;`
    const response = await runSqliteCommand([path, sql])
    return response[0][0]
}

export async function insertFile(path: string, fileJSON: FileInterface){

    const sql =`INSERT INTO files (
      path,
      players,
      winner,
      stage,
      startedAt,
      lastFrame,
      isProcessed,
      info
    ) VALUES (
      '${escapeSqlString(fileJSON.path.replace(/\|/g, ''))}',             
      '${JSON.stringify(fileJSON.players).replace(/[\|']/g, '')}',             
      ${fileJSON.winner},
      ${fileJSON.stage},                              
      ${fileJSON.startedAt ? fileJSON.startedAt : 0},                     
      ${fileJSON.lastFrame},                             
      ${fileJSON.isProcessed ? 1 : 0},                               
      '${fileJSON.info}'
    );`
  
    const response = await runSqliteCommand([path, sql])
    return response
}


export async function getItems(path: string, tableId: string, limit: number, offset: number){
    const sql = `SELECT * FROM ${tableId} ORDER BY id LIMIT ${limit} OFFSET ${offset}`
    const response = await runSqliteCommand([path, sql], 500)
    return response
}

function runSqliteCommand(args: string[], maxRetries = 50, retryDelay = 100) {
    return new Promise((resolve, reject) => {
      console.log("\nRunning SQL Command: ", args.join(" "))
  
      function attempt(retriesLeft: number) {
        const sqlite = spawn(sqlite3Path, args);
        let output = '';
  
        sqlite.stdout.on('data', (data) => {
          output += data.toString();
        });
  
        sqlite.stderr.on('data', (data) => {
          //console.error(`stderr: ${data}`);
        });
  
        sqlite.on('close', (code) => {
          if (code === 0) {
            const rows = output.trim().split('\n').map(row => row.split('|'));
            resolve(rows);
          } else {
            if (retriesLeft > 0) {
              if(retriesLeft < 2 ){
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
                console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
  
              }
              console.log(`Retrying... attempts left: ${retriesLeft}`);
              setTimeout(() => attempt(retriesLeft - 1), retryDelay);
            } else {
              console.log('Error running SQL command after maximum retries');
              reject(new Error('Failed to run SQL command'));
            }
          }
        });
      }
  
      attempt(maxRetries);
    });
  }



// Function to escape single and double quotes in a string for SQL queries
function escapeSqlString(inputString: string) {
    return inputString
    .replace(/\\/g, '\\\\')  
    .replace(/'/g, "''")    
    .replace(/"/g, '\\"'); 
}