// wrote this to generate the absurd list of image imports in Results.tsx

const fs = require('fs')
const { characters } = require('../src/constants/characters')
const { stages } = require('../src/constants/stages')

const outputfile = './imageCode.txt'

characters.forEach((character) => {
  character.colors.forEach((color) => {
    const objectKey = `${character.shortName}_${color}`
    const str = `import ${objectKey} from '../../images/${character.img}${color}.png'`
    const str2 = `images['${objectKey}'] = ${objectKey}`
    fs.appendFileSync(outputfile, `${str}\n`)
    fs.appendFileSync(outputfile, `${str2}\n`)
  })
})

Object.keys(stages).forEach((key) => {
  const objectKey = `stage_${stages[key].tag}`
  const str = `import ${objectKey} from '../../images/${stages[key].img}'`
  const str2 = `images['${objectKey}'] = ${objectKey}`
  fs.appendFileSync(outputfile, `${str}\n`)
  fs.appendFileSync(outputfile, `${str2}\n`)
})

console.log('done')
