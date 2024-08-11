
import { ClipInterface, EventEmitterInterface } from 'constants/types'
const { SlippiGame } = require("@slippi/slippi-js");


export default (
  prevResults: ClipInterface[],
  params: { [key: string]: any },
  eventEmitter: EventEmitterInterface
) => {

    const results: ClipInterface[] = []

    const { maxFiles, n } = params

    prevResults.slice(0,maxFiles==""?undefined:parseInt(maxFiles)).forEach( ( prevResult, index )  => {
        eventEmitter({ current: index, total: prevResults.length })

        const { combo } = prevResult
        const { moves, comboer, comboee, path, stage } = combo
        let frames, framesArr, x = null
        console.log(combo)
        switch(n){

            case "test":
                console.log("MOVES: ", moves)
                let upBCount = 0
                moves.forEach(move => {
                    if(move.moveId == 20){
                        upBCount++
                    }
                })
                if(upBCount > 3){
                    results.push(prevResult)
                }
                break;

            case "test2":
                try {
                    frames = new SlippiGame( path ).getFrames()
                    framesArr = Object.keys(frames)
                    console.log(framesArr)
                } catch(e){
                    console.log(e)
                    return console.log("Broken file:", path)
                }
                if(!frames) return false

                

                break;
            default: 
                return false
        }

    })

    return results

}
