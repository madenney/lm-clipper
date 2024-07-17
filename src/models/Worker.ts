import { WorkerMessage } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'
import { spawn } from 'child_process'

import methods from './methods'
import { asyncForEach } from '../lib'


function postMessage(message: WorkerMessage) {
  parentPort?.postMessage(message)
}


async function test(){
  let index = workerData.slice.bottom 

  let success = false
  while (index <= workerData.slice.top){
    // await exampleAsyncFunction(index)
    const dbPath = workerData.dbPath
    const prevTableId = workerData.prevTableId
    const nextTableId = workerData.nextTableId
    const sqlPath = workerData.sqlite3Path
    const params = workerData.params
    const sliceId = workerData.slice.id
    const top = workerData.slice.top
    const bottom = workerData.slice.bottom
    let players = 'nothing'
    try {
      const item = await getItem(sqlPath, dbPath, prevTableId, index)
      
      if(item.length == 0){
        console.log('==================================')
        console.log("------------------ > Search fail")
        console.log('==================================')
      } else if( item.length == 1){
        console.log('==================================')
        console.log("------------------ > No item found")
        console.log('==================================')
      } else {
        //console.log("Item found: ", item.length)
      }

      if(item[2]){
        players = JSON.parse(item[2])
        const p1 = players[0].displayName ? players[0].displayName : "N/A"
        const p2 = players[1].displayName ? players[1].displayName : "N/A"
        //console.log(`${p1} vs ${p2}`)
      }

      const file = {
        path: item[1],
        players: JSON.parse(item[2]),
        stage: item[4]
      } 

      //console.log(file)

      const tmpParams = {
        didKill: true,
        minHits: 5
      }

      const results = methods['slpParser2'](
        file,
        //workerData.params
        tmpParams
      )

      console.log("RESULTS: ", results.length)

      await asyncForEach(results, async result => {
        const writeResponse = await writeItem(sqlPath, dbPath, nextTableId, result)
      })

      //const writeResponse = await writeItem(sqlPath, dbPath, nextTableId, results)
      console.log(`Worker #${sliceId} completed  task #${index}`);
      
      

      //postMessage({type: 'progress', current: current, total: total})

    } catch(e){
      console.log("error in worker process")
      console.log(e)
      //console.log(players)
    }

    const current = index - bottom + 1
    const total = top - bottom
    postMessage({type: 'progress', current: current, total: total})
    index++
  }

  postMessage({ type: 'results', results: [] })
}


test()
async function exampleAsyncFunction(num) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, Math.random()*200); // Simulate an async operation
  });
}
// const results = methods[workerData.type](
//   workerData.prevResults,
//   workerData.params,
//   (message: any) => {
//     const { current, total } = message
//     postMessage({ type: 'progress', current: current, total: total })
//   }
// )

// postMessage({ type: 'results', results: results })

async function writeItem(sqlPath, dbPath, tableId, itemJSON){
  const sql = `INSERT into ${tableId} (JSON) VALUES ('${JSON.stringify(itemJSON)}')`

  // max windows spawn command length: 32,768
  if(sql.length > 32000){
    throw "Error: write command too long"
  }
  try{
    const response = await runSqliteCommand2(sqlPath, [dbPath, sql])
    return response
  } catch(e){
    console.log('Error in Write')
    console.log(e)
    throw "bahaha"
  }
}

async function getItem(sqlPath, dbPath, tableId, itemId){
  const sql = `SELECT * FROM ${tableId} WHERE id = ${itemId}`
  try{
    const response = await runSqliteCommand2(sqlPath, [dbPath, sql])
    return response[0]
  } catch(e){
    console.log('Error in read')
    throw "bahaha"
  }

}

function runSqliteCommand2(sqlPath, args, maxRetries = 50, retryDelay = 100) {
  return new Promise((resolve, reject) => {
    function attempt(retriesLeft) {
      const sqlite = spawn(sqlPath, args);
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
            if(retriesLeft < 3 ){
              console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
              console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
              console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")
              console.log("ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD ALMOST DEAD")

            }
            //console.log(`Retrying... attempts left: ${retriesLeft}`);
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

function runSqliteCommand(sqlPath, args: string[]) {
  //console.log("\nRunning SQL Command: ", args.join(" "))
  return new Promise<any>((resolve, reject) => {
    const sqlite = spawn(sqlPath, args);
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
        //console.log("Successfully ran SQL command\n")
        const rows = output.trim().split('\n').map(row => row.split('|'));
        return resolve(rows)
      } else {
        console.log("Error running SQL command", code)
        if(code == 5){
          console.log("Data base was blocked")
        }
        return reject()
      }
    });
  })

}