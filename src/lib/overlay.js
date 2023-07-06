
const fs = require("fs")
const path = require("path")
const { PythonShell } = require("python-shell");


const generateOverlays = async function( replays, outputDir ){
    console.log("GENERATING ", replays.length, " overlays")
    
    await asyncForEach( replays, async (replay) => {
 
        replay.overlayPath = path.resolve(outputDir, `${replay.index}.png`)

        const { path: filePath } = replay
        const dirs = filePath.split("/")
        let source = "Source: "

        const deeper = ["GALINT Collection", "Half Moon"]
        if(dirs[5] == "Local Drives"){
            source += dirs[6] + " netplay"
        } else if (dirs[5] == "GALINT Collection"){
            source += `${dirs[5]}/${dirs[6]}`
        } else if (dirs[5] == "Half Moon"){
            source += `Half Moon ${dirs[6]}`
        } else {
            source += dirs[5]
        }

        const args = []
        args.push(`--outputPath=${replay.overlayPath}`)
        args.push(`--text=${source}`)

        const scriptPath = path.resolve("scripts")
        const pyShellOptions = {
            mode: "text",
            pythonPath: 'python3',
            pythonOptions: ["-u"],
            scriptPath,
            args
        };
        await new Promise((resolve,reject) => {
            PythonShell.run("overlay.py", pyShellOptions, (err, results) => {
                if (err) throw err;
                resolve()
            });
        })
    })
    console.log("Overlays generated.")
}


export default { 
	generateOverlays
}

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}