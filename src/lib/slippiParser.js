
//const slpParser = require("slp-parser-js")

const validStageIds = [2,3,8,28,31,32]

const getInfoFromSlpFile = function( file ){
	const game = new slpParser.default( file )

	// check settings for indicators of invalid game
	const settings = game.getSettings()
	if( settings.isTeams ){ return { invalid: true, reason: "teams" } }
	if( settings.players.length !== 2 ){ return { invalid: true, reason: "!2 players"}}
	if( validStageIds.indexOf( settings.stageId ) === -1 ){ return { invalid: true, reason: "Illegal stage"}}
	const p1 = settings.players[0]
	const p2 = settings.players[1]
	if( p1.type === 1 || p2.type === 1 ){ return { invalid: true, reason: "Bot"}}
	if( p1.startStocks != 4 || p2.startStocks != 4 ){ return { invalid: true, reason: "startStocks != 4"}}

	// check metadata for indicators of invalid game
	const metadata = game.getMetadata()
	const length = metadata.lastFrame / 60 
	if( isNaN( length ) ){ return { invalid: true, reason: "No metadata"} }
	if( length < 45 ){ return { invalid: true, reason: "Game Length < 45 seconds"} }

	// check stats for indicators of invalid game
	const { overall, stocks, gameComplete, conversions } = game.getStats()
	// TODO: Come back to this
	if( !gameComplete ){ return { invalid: true, reason: "Game incomplete"}}
	if( overall.every( p => p.totalDamage < 100 )){ return { invalid: true, reason: "Damage < 100"} }
	if( overall.some( p => p.inputCount < 100 )){ return { invalid: true, reason: "InputCount < 100"} }
	const p1Stocks = stocks.filter( stock => stock.playerIndex === p1.playerIndex )
	const p2Stocks = stocks.filter( stock => stock.playerIndex === p2.playerIndex )
	// TODO: Come back to this
	if( p1Stocks.length < 4 && p2Stocks.length < 4 ){ return { invalid: true, reason: "Neither player lost 4 stocks"} }


	// Get Winner
	let winnerIndex
	if( p1Stocks.length < 4 ){ winnerIndex = p1Stocks[0].playerIndex }
	if( p2Stocks.length < 4 ){ winnerIndex = p2Stocks[0].playerIndex }
	if( typeof winnerIndex === "undefined" ){
		// if both last stocks ended on null, game must have ended with pause
		if( !p1Stocks[3].endFrame && !p2Stocks[3].endFrame){
			// assume winnerIndex was last player to win a conversion
			winnerIndex = conversions[conversions.length-1].playerIndex
		} else {
			if( !p1Stocks[3].endFrame ){ 
				winnerIndex = p1Stocks[0].playerIndex 
			} else {
				winnerIndex = p2Stocks[0].playerIndex
			}
		}
	}

	if( typeof winnerIndex === "undefined" ){ throw "Error: Somehow didn't determine a winner." } 

	let winner, loser
	if( winnerIndex === settings.players[0].playerIndex ){
		winner = settings.players[0]
		loser = settings.players[1]
	} else {
		winner = settings.players[1]
		loser = settings.players[0]
	}

	return {
		startAt: metadata.startAt,
		startAtTimestamp: new Date(metadata.startAt).getTime(),
		length: Math.floor( metadata.lastFrame / 60 ), // TODO: Change to 59.994?
		stageId: settings.stageId,
		winner: winnerIndex,
		players: [{
			playerIndex: p1.playerIndex,
			port: p1.port,
			characterId: p1.characterId,
			characterColor: p1.characterColor,
			nametag: p1.nametag
		},{
			playerIndex: p2.playerIndex,
			port: p2.port,
			characterId: p2.characterId,
			characterColor: p2.characterColor,
			nametag: p2.nametag
		}]
	}
}

function getDeepInfoFromSlpFile( file ){
	console.log("FILE PATH: ", file )
	const game = new slpParser.default( file )
	const settings = game.getSettings()
	const metadata = game.getMetadata()
	const length = metadata.lastFrame / 60 
	const gameStats = game.getStats()
	return {
		settings,
		metadata,
		gameStats
	}
}

function getGameStats( file ){
	const game = new slpParser.default( file )
	return game.getStats()
}

export default { 
	getInfoFromSlpFile,
	getDeepInfoFromSlpFile,
	getGameStats
}